// Route optimization for one day (Phase 3).
//
// What gets planned: every order that is unassigned or sits on a route
// that has not started yet. Routes a driver has started (or finished) are
// left exactly as they are, and so are those drivers. The dispatcher can
// also keep chosen drivers' routes as they are (keepDriverIds). The fleet is every
// active driver with an active vehicle.
//
// The current routes are the manual plan the result is compared with, on
// the same measure: straight-line distance from each route's first stop to
// its last (routes are open, drivers do not return to a depot). service-
// python solves it with OR-Tools; nothing changes until a dispatcher
// accepts the run, and a run goes stale if the day changed in between.
const crypto = require('node:crypto');
const { pool, withTransaction, TODAY_SQL } = require('./db');
const { HttpError } = require('./errors');
const { distanceMatrix } = require('./distance');
const { setRouteStops } = require('./dispatch');

const serviceUrl = () => (process.env.PYTHON_SERVICE_URL || 'http://service-python:8000').replace(/\/$/, '');
const DEFAULT_CAPACITY = { bike: 20, keke: 150, van: 800, truck: 3000 };
const TIME_LIMIT_S = Number(process.env.OPTIMIZER_TIME_LIMIT_S || 5);

const minutes = (t) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const km = (m) => Math.round(m / 10) / 100;

/** Everything the optimizer and the comparison need, read in one place. */
async function loadDay(db, date, keepDriverIds = []) {
  const keep = new Set(keepDriverIds.map(Number));
  const { rows: routes } = await db.query(
    `SELECT r.id, r.driver_id, r.status, d.name AS driver_name,
            bool_and(s.status = 'pending') FILTER (WHERE s.id IS NOT NULL) AS untouched
     FROM routes r JOIN drivers d ON d.id = r.driver_id
     LEFT JOIN stops s ON s.route_id = r.id
     WHERE r.route_date = $1 GROUP BY r.id, d.name ORDER BY r.id`,
    [date],
  );
  const open = routes.filter((r) => r.status === 'planned' && r.untouched !== false && !keep.has(Number(r.driver_id)));
  const lockedDrivers = new Set([...routes.filter((r) => !open.includes(r)).map((r) => r.driver_id), ...keep]);
  const openIds = open.map((r) => Number(r.id));

  const { rows: stops } = await db.query(
    `SELECT s.id, s.order_id, s.stop_type, s.address, s.route_id, s.sequence_number,
            ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng,
            o.customer_name, o.weight_kg, o.dropoff_after::text AS dropoff_after, o.dropoff_before::text AS dropoff_before
     FROM stops s JOIN orders o ON o.id = s.order_id
     WHERE (s.route_id = ANY($1::bigint[]))
        OR (o.status = 'pending' AND s.route_id IS NULL)
     ORDER BY s.route_id NULLS LAST, s.sequence_number, s.id`,
    [openIds],
  );
  const { rows: fleet } = await db.query(
    `SELECT d.id AS driver_id, d.name, v.type, v.plate_number, v.capacity_kg
     FROM drivers d JOIN vehicles v ON v.id = d.vehicle_id
     WHERE d.status = 'active' AND v.status = 'active' ORDER BY d.id`,
  );
  return {
    open,
    stops,
    fleet: fleet.filter((f) => !lockedDrivers.has(f.driver_id)).map((f) => ({ ...f, capacity_kg: Number(f.capacity_kg ?? DEFAULT_CAPACITY[f.type] ?? 100) })),
    lockedDrivers: [...lockedDrivers],
  };
}

// The state a run was computed from. Accepting re-checks it, so a plan made
// before someone edited a route or added an order is never applied blindly.
function fingerprint(day) {
  const routes = day.open.map((r) => [Number(r.id), day.stops.filter((s) => Number(s.route_id) === Number(r.id)).map((s) => Number(s.id))]);
  const pending = day.stops.filter((s) => s.route_id === null).map((s) => Number(s.id)).sort((a, b) => a - b);
  return crypto.createHash('sha256').update(JSON.stringify({ routes, pending, fleet: day.fleet.map((f) => f.driver_id) })).digest('hex');
}

function routeKm(stopIds, index, matrix) {
  let m = 0;
  for (let i = 1; i < stopIds.length; i += 1) m += matrix.distances_m[index.get(stopIds[i - 1])][index.get(stopIds[i])];
  return m;
}

async function optimizeDay(date, userId, { keepDriverIds = [] } = {}) {
  const { rows: d } = await pool.query(`SELECT COALESCE($1::date, ${TODAY_SQL})::text AS d`, [date ?? null]);
  const day = await loadDay(pool, d[0].d, keepDriverIds);
  const routeDate = d[0].d;

  // Orders need both stops and coordinates to be planned.
  const byOrder = new Map();
  for (const s of day.stops) {
    const o = byOrder.get(s.order_id) ?? { order_id: Number(s.order_id), customer: s.customer_name, weight_kg: Number(s.weight_kg),
      after: minutes(s.dropoff_after), before: minutes(s.dropoff_before) };
    o[s.stop_type] = s;
    byOrder.set(s.order_id, o);
  }
  const unassigned = [];
  const plannable = [];
  for (const o of byOrder.values()) {
    if (!o.pickup || !o.dropoff) continue;
    if (o.pickup.lat == null || o.dropoff.lat == null) unassigned.push({ order_id: o.order_id, customer: o.customer, reason: 'No coordinates for the pickup or dropoff' });
    else plannable.push(o);
  }
  if (!plannable.length) throw new HttpError(409, 'There are no orders to optimize for this day');
  if (!day.fleet.length) throw new HttpError(409, 'No driver with an active vehicle is free to take routes this day');

  const points = [];
  const index = new Map();
  for (const o of plannable) {
    for (const s of [o.pickup, o.dropoff]) {
      index.set(Number(s.id), points.length);
      points.push({ lat: Number(s.lat), lng: Number(s.lng), stop: s });
    }
  }
  const matrix = await distanceMatrix(points);

  // The manual plan, measured the same way as the proposal.
  const manual = day.open.map((r) => {
    const ids = day.stops.filter((s) => Number(s.route_id) === Number(r.id) && index.has(Number(s.id))).map((s) => Number(s.id));
    return { route_id: Number(r.id), driver_id: r.driver_id, driver: r.driver_name, stop_ids: ids, stops: ids.length, distance_m: routeKm(ids, index, matrix) };
  }).filter((r) => r.stops);
  const manualOrders = new Set(manual.flatMap((r) => r.stop_ids.map((sid) => Number(points[index.get(sid)].stop.order_id))));

  let res;
  try {
    res = await fetch(`${serviceUrl()}/optimize/routes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vehicles: day.fleet.map((f) => ({ driver_id: f.driver_id, capacity_kg: f.capacity_kg })),
        orders: plannable.map((o) => ({
          order_id: o.order_id, pickup: index.get(Number(o.pickup.id)), dropoff: index.get(Number(o.dropoff.id)),
          weight_kg: o.weight_kg, dropoff_after_min: o.after, dropoff_before_min: o.before,
        })),
        distances_m: matrix.distances_m,
        durations_s: matrix.durations_s,
        time_limit_s: TIME_LIMIT_S,
      }),
      signal: AbortSignal.timeout((TIME_LIMIT_S + 20) * 1000),
    });
  } catch {
    throw new HttpError(503, 'The optimizer is not reachable. Is service-python running?');
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, out.detail?.message ?? 'The optimizer failed');
  if (out.status !== 'ok') throw new HttpError(422, 'The optimizer found no plan for these orders and vehicles');

  const fleetBy = new Map(day.fleet.map((f) => [f.driver_id, f]));
  const orderBy = new Map(plannable.map((o) => [o.order_id, o]));
  const proposed = out.routes.map((r) => {
    const f = fleetBy.get(r.driver_id);
    const stops = r.stops.map((i, k) => {
      const s = points[i].stop;
      return { stop_id: Number(s.id), order_id: Number(s.order_id), type: s.stop_type, address: s.address, customer: s.customer_name, eta: clock(r.arrival_min[k]) };
    });
    return { driver_id: r.driver_id, driver: f.name, vehicle: `${f.type} ${f.plate_number}`, capacity_kg: f.capacity_kg,
      peak_load_kg: r.peak_load_kg, stop_ids: stops.map((s) => s.stop_id), stops, distance_m: r.distance_m };
  });
  for (const oid of out.unassigned) {
    const o = orderBy.get(oid);
    unassigned.push({ order_id: oid, customer: o.customer, reason: `Fits no vehicle and time window (${o.weight_kg} kg${o.after != null || o.before != null ? `, window ${o.after != null ? clock(o.after) : 'any'} to ${o.before != null ? clock(o.before) : 'any'}` : ''})` });
  }
  validate(proposed, orderBy);

  const manualM = manual.reduce((n, r) => n + r.distance_m, 0);
  const proposedM = proposed.reduce((n, r) => n + r.distance_m, 0);
  // Like for like: the proposal also covers orders the manual plan has not
  // placed yet, so report the distance for the manual plan's orders too.
  const sameOrdersM = proposed.reduce((n, r) => {
    const ids = r.stop_ids.filter((sid) => manualOrders.has(Number(points[index.get(sid)].stop.order_id)));
    return n + routeKm(ids, index, matrix);
  }, 0);

  const summary = {
    manual: { routes: manual.length, orders: manualOrders.size, km: km(manualM) },
    proposed: { routes: proposed.length, orders: plannable.length - out.unassigned.length, km: km(proposedM), km_for_manual_orders: km(sameOrdersM) },
    unplanned_orders_added: plannable.filter((o) => !manualOrders.has(o.order_id)).length,
    locked_drivers: day.lockedDrivers,
  };
  const { rows } = await pool.query(
    `INSERT INTO optimization_runs (route_date, created_by, distance_provider, manual, proposed, unassigned, manual_km, proposed_km, solve_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, created_at`,
    [routeDate, userId, matrix.provider,
      JSON.stringify({ routes: manual.map((r) => ({ ...r, distance_km: km(r.distance_m) })), fingerprint: fingerprint(day), summary,
        keep_driver_ids: keepDriverIds.map(Number) }),
      JSON.stringify(proposed.map((r) => ({ ...r, distance_km: km(r.distance_m) }))), JSON.stringify(unassigned),
      km(manualM), km(proposedM), out.solve_ms],
  );
  return getRun(rows[0].id);
}

// Belt and braces: the solver's constraints guarantee these, and a plan
// that broke one must never reach a dispatcher.
function validate(routes, orderBy) {
  const seen = new Map();
  for (const r of routes) {
    let load = 0;
    r.stops.forEach((s, i) => {
      const o = orderBy.get(s.order_id);
      const key = `${s.order_id}:${s.type}`;
      if (seen.has(key)) throw new HttpError(500, `Optimizer placed stop ${s.stop_id} twice`);
      seen.set(key, { driver: r.driver_id, i });
      load += s.type === 'pickup' ? o.weight_kg : -o.weight_kg;
      if (load > r.capacity_kg + 1e-6) throw new HttpError(500, `Optimizer overloaded ${r.driver}`);
    });
  }
  for (const [key, at] of seen) {
    const [oid, type] = key.split(':');
    if (type !== 'dropoff') continue;
    const p = seen.get(`${oid}:pickup`);
    if (!p || p.driver !== at.driver || p.i > at.i) throw new HttpError(500, `Optimizer broke pickup before dropoff for order #${oid}`);
  }
}

async function getRun(id) {
  const { rows } = await pool.query(
    `SELECT r.id, r.route_date::text AS route_date, r.distance_provider, r.manual, r.proposed, r.unassigned,
            r.manual_km, r.proposed_km, r.solve_ms, r.status, r.created_at, r.decided_at, u.full_name AS created_by
     FROM optimization_runs r LEFT JOIN users u ON u.id = r.created_by WHERE r.id = $1`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, 'Optimization not found');
  const { fingerprint: _, ...manual } = rows[0].manual;
  return { ...rows[0], manual };
}

/** Applies a proposed run as the day's routes, in one transaction. */
async function acceptRun(id, userId, actor) {
  try {
    await applyRun(id, userId, actor);
  } catch (err) {
    // Marked after the rollback, so the "stale" status itself is kept.
    if (err.details?.code === 'stale') await pool.query("UPDATE optimization_runs SET status = 'stale' WHERE id = $1 AND status = 'proposed'", [id]);
    throw err;
  }
  return getRun(id);
}

async function applyRun(id, userId, actor) {
  await withTransaction(async (db) => {
    const { rows } = await db.query('SELECT * FROM optimization_runs WHERE id = $1 FOR UPDATE', [id]);
    const run = rows[0];
    if (!run) throw new HttpError(404, 'Optimization not found');
    if (run.status !== 'proposed') throw new HttpError(409, `This plan was already ${run.status}`);
    const day = await loadDay(db, run.route_date, run.manual.keep_driver_ids ?? []);
    if (fingerprint(day) !== run.manual.fingerprint) {
      throw new HttpError(409, 'Routes or orders changed since this plan was made. Run the optimizer again.', { code: 'stale' });
    }
    const plan = new Map(run.proposed.map((r) => [r.driver_id, r.stop_ids]));
    const routeOf = new Map(day.open.map((r) => [r.driver_id, Number(r.id)]));

    // Pass 1: each existing route keeps only the stops that stay with its
    // driver, so moved stops are free before pass 2 places them.
    for (const [driverId, routeId] of routeOf) {
      const current = new Set(day.stops.filter((s) => Number(s.route_id) === routeId).map((s) => Number(s.id)));
      const stays = (plan.get(driverId) ?? []).filter((sid) => current.has(sid));
      await setRouteStops(db, routeId, stays, actor);
    }
    // Pass 2: every driver in the plan gets the full new list.
    for (const [driverId, stopIds] of plan) {
      let routeId = routeOf.get(driverId);
      if (!routeId) {
        const { rows: created } = await db.query(
          `INSERT INTO routes (driver_id, vehicle_id, route_date)
           SELECT d.id, d.vehicle_id, $2 FROM drivers d WHERE d.id = $1 RETURNING id`,
          [driverId, run.route_date],
        );
        routeId = Number(created[0].id);
      }
      await setRouteStops(db, routeId, stopIds, actor);
    }
    // Planned routes the optimizer left empty go away.
    for (const [driverId, routeId] of routeOf) {
      if (!plan.has(driverId)) await db.query('DELETE FROM routes WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM stops WHERE route_id = $1)', [routeId]);
    }
    await db.query("UPDATE optimization_runs SET status = 'accepted', decided_by = $2, decided_at = now() WHERE id = $1", [id, userId]);
  });
}

async function discardRun(id, userId) {
  const { rowCount } = await pool.query(
    "UPDATE optimization_runs SET status = 'discarded', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'proposed'",
    [id, userId],
  );
  if (!rowCount) throw new HttpError(409, 'This plan is no longer waiting for a decision');
  return getRun(id);
}

module.exports = { optimizeDay, acceptRun, discardRun, getRun };
