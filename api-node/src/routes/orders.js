const express = require('express');
const { pool, withTransaction } = require('../db');
const { asyncHandler, HttpError } = require('../errors');
const { z, parse, phone, location, idParam, isoDate } = require('../validation');
const { requireAuth, STAFF } = require('../auth');
const { recordEvent, staffActor } = require('../events');
const { pointSql, latLngSql, toLocation, lngLat } = require('../geo');
const { resequenceRoute } = require('../dispatch');

const router = express.Router();
router.use(requireAuth(...STAFF));

const ORDER_STATUSES = ['pending', 'assigned', 'picked_up', 'en_route', 'delivered', 'cancelled'];

const SELECT = `
  SELECT o.id, o.customer_name, o.customer_phone,
         o.pickup_address, ${latLngSql('o.pickup_location', 'pickup')},
         o.dropoff_address, ${latLngSql('o.dropoff_location', 'dropoff')},
         o.status, o.created_at,
         ps.id AS pickup_stop_id, ds.id AS dropoff_stop_id, ps.route_id
  FROM orders o
  LEFT JOIN stops ps ON ps.order_id = o.id AND ps.stop_type = 'pickup'
  LEFT JOIN stops ds ON ds.order_id = o.id AND ds.stop_type = 'dropoff'`;

function shape(r) {
  return {
    id: r.id,
    customer_name: r.customer_name,
    customer_phone: r.customer_phone,
    pickup_address: r.pickup_address,
    pickup_location: toLocation(r.pickup_lat, r.pickup_lng),
    dropoff_address: r.dropoff_address,
    dropoff_location: toLocation(r.dropoff_lat, r.dropoff_lng),
    status: r.status,
    route_id: r.route_id,
    pickup_stop_id: r.pickup_stop_id,
    dropoff_stop_id: r.dropoff_stop_id,
    created_at: r.created_at,
  };
}

async function getOrder(db, orderId) {
  const { rows } = await db.query(`${SELECT} WHERE o.id = $1`, [orderId]);
  if (!rows[0]) throw new HttpError(404, 'Order not found');
  return shape(rows[0]);
}

const fields = {
  customer_name: z.string().trim().min(1).max(255),
  customer_phone: phone,
  pickup_address: z.string().trim().min(1),
  pickup_location: location,
  dropoff_address: z.string().trim().min(1),
  dropoff_location: location,
};

const createOrder = z.object({
  ...fields,
  pickup_location: location.optional().default(null),
  dropoff_location: location.optional().default(null),
});
const updateOrder = z.object(fields).partial();

const listQuery = z.object({
  status: z.string().optional().transform((v, ctx) => {
    if (!v) return null;
    const list = v.split(',');
    if (list.some((s) => !ORDER_STATUSES.includes(s))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `status must be one of ${ORDER_STATUSES.join(', ')}` });
      return z.NEVER;
    }
    return list;
  }),
  q: z.string().trim().min(1).optional(),
  date: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /orders?status=pending,assigned&q=lekki&date=2026-11-13
// date filters on the Lagos calendar day the order was created.
router.get('/', asyncHandler(async (req, res) => {
  const f = parse(listQuery, req.query);
  const like = f.q ? `%${f.q.replace(/[%_\\]/g, '\\$&')}%` : null;
  const { rows } = await pool.query(
    `${SELECT}
     WHERE ($1::text[] IS NULL OR o.status = ANY($1))
       AND ($2::text IS NULL OR o.customer_name ILIKE $2 OR o.customer_phone ILIKE $2
            OR o.pickup_address ILIKE $2 OR o.dropoff_address ILIKE $2)
       AND ($3::date IS NULL OR (o.created_at AT TIME ZONE 'Africa/Lagos')::date = $3)
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT $4 OFFSET $5`,
    [f.status, like, f.date ?? null, f.limit, f.offset],
  );
  res.json(rows.map(shape));
}));

// Full order with its timeline.
router.get('/:id', asyncHandler(async (req, res) => {
  const orderId = idParam(req);
  const order = await getOrder(pool, orderId);
  const { rows: events } = await pool.query(
    `SELECT id, stop_id, event_type, actor_type, actor_id, occurred_at, created_at
     FROM order_events WHERE order_id = $1 ORDER BY occurred_at, id`,
    [orderId],
  );
  res.json({ ...order, events });
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = parse(createOrder, req.body);
  const order = await withTransaction(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO orders (customer_name, customer_phone,
         pickup_address, pickup_location, dropoff_address, dropoff_location)
       VALUES ($1, $2, $3, ${pointSql('$4', '$5')}, $6, ${pointSql('$7', '$8')})
       RETURNING id`,
      [b.customer_name, b.customer_phone,
        b.pickup_address, ...lngLat(b.pickup_location),
        b.dropoff_address, ...lngLat(b.dropoff_location)],
    );
    const orderId = rows[0].id;
    // Every order has exactly one pickup and one dropoff stop. They start
    // unassigned and get a route when the dispatcher plans the day.
    await db.query(
      `INSERT INTO stops (order_id, stop_type, address, location)
       SELECT $1, 'pickup', pickup_address, pickup_location FROM orders WHERE id = $1
       UNION ALL
       SELECT $1, 'dropoff', dropoff_address, dropoff_location FROM orders WHERE id = $1`,
      [orderId],
    );
    await recordEvent(db, { orderId, type: 'created', ...staffActor(req) });
    return getOrder(db, orderId);
  });
  res.status(201).json(order);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const orderId = idParam(req);
  const b = parse(updateOrder, req.body);
  const order = await withTransaction(async (db) => {
    const { rows } = await db.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!rows[0]) throw new HttpError(404, 'Order not found');

    for (const kind of ['pickup', 'dropoff']) {
      const addressChanged = `${kind}_address` in b || `${kind}_location` in b;
      if (!addressChanged) continue;
      const { rows: stop } = await db.query(
        'SELECT status FROM stops WHERE order_id = $1 AND stop_type = $2',
        [orderId, kind],
      );
      if (!['pending', 'assigned'].includes(rows[0].status) || (stop[0] && stop[0].status !== 'pending')) {
        throw new HttpError(409, `The ${kind} can no longer be changed once the driver has started on it`);
      }
    }

    await db.query(
      `UPDATE orders SET
         customer_name = COALESCE($2, customer_name),
         customer_phone = COALESCE($3, customer_phone),
         pickup_address = COALESCE($4, pickup_address),
         pickup_location = CASE WHEN $5::boolean THEN ${pointSql('$6', '$7')} ELSE pickup_location END,
         dropoff_address = COALESCE($8, dropoff_address),
         dropoff_location = CASE WHEN $9::boolean THEN ${pointSql('$10', '$11')} ELSE dropoff_location END
       WHERE id = $1`,
      [orderId, b.customer_name ?? null, b.customer_phone ?? null,
        b.pickup_address ?? null, 'pickup_location' in b, ...lngLat(b.pickup_location),
        b.dropoff_address ?? null, 'dropoff_location' in b, ...lngLat(b.dropoff_location)],
    );
    // Keep the stop copies of address and location in step with the order.
    await db.query(
      `UPDATE stops s SET
         address = CASE s.stop_type WHEN 'pickup' THEN o.pickup_address ELSE o.dropoff_address END,
         location = CASE s.stop_type WHEN 'pickup' THEN o.pickup_location ELSE o.dropoff_location END
       FROM orders o WHERE o.id = s.order_id AND o.id = $1`,
      [orderId],
    );
    await recordEvent(db, { orderId, type: 'updated', ...staffActor(req) });
    return getOrder(db, orderId);
  });
  res.json(order);
}));

// Cancelling takes the order's stops off any route. Orders the driver has
// already picked up cannot be cancelled here, they must be delivered or
// handled by the dispatcher by phone.
router.post('/:id/cancel', asyncHandler(async (req, res) => {
  const orderId = idParam(req);
  const order = await withTransaction(async (db) => {
    const { rows } = await db.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!rows[0]) throw new HttpError(404, 'Order not found');
    if (!['pending', 'assigned'].includes(rows[0].status)) {
      throw new HttpError(409, `Cannot cancel an order that is ${rows[0].status}`);
    }
    const { rows: onRoutes } = await db.query(
      'SELECT DISTINCT route_id FROM stops WHERE order_id = $1 AND route_id IS NOT NULL',
      [orderId],
    );
    await db.query(
      'UPDATE stops SET route_id = NULL, sequence_number = NULL WHERE order_id = $1',
      [orderId],
    );
    await db.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [orderId]);
    await recordEvent(db, { orderId, type: 'cancelled', ...staffActor(req) });
    for (const { route_id: routeId } of onRoutes) {
      await resequenceRoute(db, routeId);
    }
    return getOrder(db, orderId);
  });
  res.json(order);
}));

module.exports = router;
