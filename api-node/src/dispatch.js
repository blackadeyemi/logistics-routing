// Route and stop rules shared by the dispatcher and driver endpoints.
const { HttpError } = require('./errors');
const { recordEvent } = require('./events');
const { latLngSql, toLocation } = require('./geo');

const DONE = ['completed', 'skipped'];

// Renumber a route's stops 1..n, keeping their current order.
async function resequenceRoute(db, routeId) {
  await db.query(
    `UPDATE stops s SET sequence_number = r.n
     FROM (SELECT id, row_number() OVER (ORDER BY sequence_number, id) AS n
           FROM stops WHERE route_id = $1) r
     WHERE s.id = r.id`,
    [routeId],
  );
  await refreshRouteStatus(db, routeId);
}

// planned: nothing started. in_progress: some stop started.
// completed: every stop completed or skipped.
async function refreshRouteStatus(db, routeId) {
  await db.query(
    `UPDATE routes r SET status = CASE
       WHEN c.total > 0 AND c.done = c.total THEN 'completed'
       WHEN c.started > 0 THEN 'in_progress'
       ELSE 'planned' END
     FROM (SELECT count(*) AS total,
                  count(*) FILTER (WHERE status IN ('completed', 'skipped')) AS done,
                  count(*) FILTER (WHERE status <> 'pending') AS started
           FROM stops WHERE route_id = $1) c
     WHERE r.id = $1`,
    [routeId],
  );
}

const ROUTE_SELECT = `
  SELECT r.id, r.driver_id, r.vehicle_id, r.route_date, r.status, r.created_at,
         CASE WHEN d.id IS NULL THEN NULL ELSE
           json_build_object('id', d.id, 'name', d.name, 'phone', d.phone) END AS driver,
         CASE WHEN v.id IS NULL THEN NULL ELSE
           json_build_object('id', v.id, 'type', v.type, 'plate_number', v.plate_number) END AS vehicle
  FROM routes r
  LEFT JOIN drivers d ON d.id = r.driver_id
  LEFT JOIN vehicles v ON v.id = r.vehicle_id`;

async function getRouteStops(db, routeId) {
  const { rows } = await db.query(
    `SELECT s.id, s.order_id, s.sequence_number, s.stop_type, s.address, s.notes,
            ${latLngSql('s.location', 'loc')}, s.status, s.arrived_at, s.completed_at,
            o.customer_name, o.customer_phone, o.status AS order_status
     FROM stops s JOIN orders o ON o.id = s.order_id
     WHERE s.route_id = $1 ORDER BY s.sequence_number, s.id`,
    [routeId],
  );
  return rows.map(({ loc_lat: lat, loc_lng: lng, ...s }) => ({ ...s, location: toLocation(lat, lng) }));
}

async function getRoute(db, routeId) {
  const { rows } = await db.query(`${ROUTE_SELECT} WHERE r.id = $1`, [routeId]);
  if (!rows[0]) throw new HttpError(404, 'Route not found');
  return { ...rows[0], stops: await getRouteStops(db, routeId) };
}

// Replace a route's stops with stopIds, in that order. Rules:
// - a stop can only be on one route
// - both stops of an order go on the same route, pickup before dropoff
// - stops the driver has started (arrived, completed, skipped) stay on
// - cancelled and delivered orders cannot be added
async function setRouteStops(db, routeId, stopIds, actor) {
  const { rows: route } = await db.query('SELECT id FROM routes WHERE id = $1 FOR UPDATE', [routeId]);
  if (!route[0]) throw new HttpError(404, 'Route not found');

  if (new Set(stopIds).size !== stopIds.length) {
    throw new HttpError(400, 'A stop appears more than once');
  }

  const { rows: current } = await db.query(
    'SELECT id, order_id, status FROM stops WHERE route_id = $1 FOR UPDATE',
    [routeId],
  );
  const { rows: requested } = await db.query(
    `SELECT s.id, s.order_id, s.stop_type, s.status, s.route_id, o.status AS order_status
     FROM stops s JOIN orders o ON o.id = s.order_id
     WHERE s.id = ANY($1::bigint[]) FOR UPDATE OF s`,
    [stopIds],
  );

  const byId = new Map(requested.map((s) => [Number(s.id), s]));
  const missing = stopIds.filter((sid) => !byId.has(sid));
  if (missing.length) throw new HttpError(400, 'Unknown stop ids', { stop_ids: missing });

  const problems = [];
  for (const s of requested) {
    if (s.route_id !== null && Number(s.route_id) !== routeId) {
      problems.push({ stop_id: s.id, message: `Already on route ${s.route_id}` });
    } else if (s.route_id === null && ['cancelled', 'delivered'].includes(s.order_status)) {
      problems.push({ stop_id: s.id, message: `Order ${s.order_id} is ${s.order_status}` });
    }
  }

  const keep = new Set(stopIds);
  const removed = current.filter((s) => !keep.has(Number(s.id)));
  for (const s of removed) {
    if (s.status !== 'pending') {
      problems.push({ stop_id: s.id, message: `Stop is ${s.status} and cannot be taken off the route` });
    }
  }

  const position = new Map(stopIds.map((sid, i) => [sid, i]));
  const perOrder = new Map();
  for (const s of requested) {
    const entry = perOrder.get(s.order_id) || {};
    entry[s.stop_type] = Number(s.id);
    perOrder.set(s.order_id, entry);
  }
  for (const [orderId, { pickup, dropoff }] of perOrder) {
    if (!pickup || !dropoff) {
      problems.push({ order_id: orderId, message: 'Pickup and dropoff must be on the same route' });
    } else if (position.get(pickup) > position.get(dropoff)) {
      problems.push({ order_id: orderId, message: 'Pickup must come before dropoff' });
    }
  }
  if (problems.length) throw new HttpError(409, 'Route cannot be saved', problems);

  // Clear the old order first so sequence numbers never collide midway.
  await db.query('UPDATE stops SET route_id = NULL, sequence_number = NULL WHERE route_id = $1', [routeId]);
  await db.query(
    `UPDATE stops s SET route_id = $1, sequence_number = t.n
     FROM unnest($2::bigint[]) WITH ORDINALITY AS t(id, n)
     WHERE s.id = t.id`,
    [routeId, stopIds],
  );

  const currentOrders = new Set(current.map((s) => s.order_id));
  const newOrders = [...perOrder.keys()].filter((o) => !currentOrders.has(o));
  const goneOrders = [...new Set(removed.map((s) => s.order_id))];

  for (const orderId of newOrders) {
    await db.query("UPDATE orders SET status = 'assigned' WHERE id = $1 AND status = 'pending'", [orderId]);
    await recordEvent(db, { orderId, type: 'assigned', ...actor });
  }
  for (const orderId of goneOrders) {
    await db.query("UPDATE orders SET status = 'pending' WHERE id = $1 AND status = 'assigned'", [orderId]);
    await recordEvent(db, { orderId, type: 'unassigned', ...actor });
  }

  await refreshRouteStatus(db, routeId);
}

// Earliest and latest event times accepted from a driver. Offline queues
// can hold updates for a while, but not for days.
const MAX_QUEUE_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function eventTime(occurredAt) {
  if (!occurredAt) return new Date();
  const t = new Date(occurredAt);
  const now = Date.now();
  if (t.getTime() > now + MAX_CLOCK_SKEW_MS) throw new HttpError(400, 'occurred_at is in the future');
  if (t.getTime() < now - MAX_QUEUE_AGE_MS) throw new HttpError(400, 'occurred_at is too old to accept');
  return t;
}

// Driver actions on a stop:
// - arrive: pending -> arrived
// - complete: pending or arrived -> completed. Pickup sets the order to
//   picked_up, dropoff sets it to delivered.
// - start: dropoff only, after pickup. Sets the order to en_route.
// - skip: pending or arrived -> skipped. A skipped pickup takes the whole
//   order off the route and back to pending so the dispatcher can replan
//   it. A skipped dropoff (failed delivery) stays on the route for the
//   dispatcher to follow up.
// Repeating an action that already happened is a no-op, so the PWA can
// safely retry queued updates.
// A stop status change by the driver on that route, or by staff on the
// driver's behalf (for example when the driver phones in). The rules are
// the same; only who is recorded on the event differs.
async function applyDriverAction(db, driverId, stopId, body) {
  return applyStopAction(db, stopId, body, { type: 'driver', id: driverId });
}

async function applyStopAction(db, stopId, { action, occurred_at: occurredAt, client_event_id: clientEventId }, actor) {
  let at = eventTime(occurredAt);

  const { rows } = await db.query(
    `SELECT s.id, s.order_id, s.route_id, s.stop_type, s.status,
            o.status AS order_status, r.driver_id
     FROM stops s
     JOIN orders o ON o.id = s.order_id
     JOIN routes r ON r.id = s.route_id
     WHERE s.id = $1
     FOR UPDATE OF s, o`,
    [stopId],
  );
  const stop = rows[0];
  if (!stop) throw new HttpError(404, actor.type === 'driver' ? 'Stop not found on your routes' : 'Stop not found on any route');
  if (actor.type === 'driver' && Number(stop.driver_id) !== actor.id) throw new HttpError(404, 'Stop not found on your routes');
  const routeId = Number(stop.route_id);

  if (clientEventId) {
    const { rows: seen } = await db.query('SELECT 1 FROM order_events WHERE client_event_id = $1', [clientEventId]);
    if (seen[0]) return { routeId, replayed: true };
  }

  if (stop.order_status === 'cancelled') throw new HttpError(409, 'This order was cancelled');

  // A wrong phone clock must not place an update before the order's last
  // recorded event, for example before it was assigned to this driver.
  // Compared and kept as text in SQL: a JS Date would drop microseconds
  // and land just before the event it is clamped to.
  const { rows: clamped } = await db.query(
    `SELECT GREATEST($2::timestamptz, max(occurred_at))::text AS t
     FROM order_events WHERE order_id = $1`,
    [stop.order_id, at.toISOString()],
  );
  at = clamped[0].t;

  let pickupDone = true;
  if (stop.stop_type === 'dropoff') {
    const { rows: p } = await db.query(
      "SELECT status FROM stops WHERE order_id = $1 AND stop_type = 'pickup'",
      [stop.order_id],
    );
    pickupDone = p[0] && p[0].status === 'completed';
  }

  const event = (type) => recordEvent(db, {
    orderId: stop.order_id, stopId, type, actorType: actor.type, actorId: actor.id,
    clientEventId, occurredAt: at,
  });
  const noop = { routeId, replayed: true };

  switch (action) {
    case 'arrive': {
      if (stop.status !== 'pending') {
        if (stop.status === 'arrived') return noop;
        throw new HttpError(409, `Stop is already ${stop.status}`);
      }
      if (!pickupDone) throw new HttpError(409, 'Complete the pickup first');
      await db.query('UPDATE stops SET status = $2, arrived_at = $3 WHERE id = $1', [stopId, 'arrived', at]);
      await event('arrived');
      break;
    }
    case 'complete': {
      if (stop.status === 'completed') return noop;
      if (!['pending', 'arrived'].includes(stop.status)) throw new HttpError(409, `Stop is already ${stop.status}`);
      if (!pickupDone) throw new HttpError(409, 'Complete the pickup first');
      await db.query(
        `UPDATE stops SET status = 'completed', arrived_at = COALESCE(arrived_at, $2), completed_at = $2
         WHERE id = $1`,
        [stopId, at],
      );
      const next = stop.stop_type === 'pickup' ? 'picked_up' : 'delivered';
      await db.query('UPDATE orders SET status = $2 WHERE id = $1', [stop.order_id, next]);
      await event(next);
      break;
    }
    case 'start': {
      if (stop.stop_type !== 'dropoff') throw new HttpError(400, 'Only a dropoff can be started');
      if (stop.order_status === 'en_route') return noop;
      if (stop.order_status !== 'picked_up' || stop.status !== 'pending') {
        throw new HttpError(409, pickupDone ? `Order is ${stop.order_status}` : 'Complete the pickup first');
      }
      await db.query("UPDATE orders SET status = 'en_route' WHERE id = $1", [stop.order_id]);
      await event('en_route');
      break;
    }
    case 'skip': {
      if (stop.status === 'skipped') return noop;
      if (!['pending', 'arrived'].includes(stop.status)) throw new HttpError(409, `Stop is already ${stop.status}`);
      await event('skipped');
      if (stop.stop_type === 'pickup') {
        await db.query(
          `UPDATE stops SET route_id = NULL, sequence_number = NULL, status = 'pending', arrived_at = NULL
           WHERE order_id = $1`,
          [stop.order_id],
        );
        await db.query("UPDATE orders SET status = 'pending' WHERE id = $1", [stop.order_id]);
        await resequenceRoute(db, routeId);
        return { routeId, replayed: false };
      }
      await db.query("UPDATE stops SET status = 'skipped' WHERE id = $1", [stopId]);
      break;
    }
    default:
      throw new HttpError(400, 'Unknown action');
  }

  await refreshRouteStatus(db, routeId);
  return { routeId, replayed: false };
}

module.exports = {
  DONE, resequenceRoute, refreshRouteStatus, ROUTE_SELECT, applyStopAction,
  getRoute, getRouteStops, setRouteStops, applyDriverAction,
};
