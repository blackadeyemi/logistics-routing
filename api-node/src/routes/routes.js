const express = require('express');
const { pool, withTransaction, TODAY_SQL } = require('../db');
const { asyncHandler, HttpError } = require('../errors');
const { z, parse, id, idParam, isoDate } = require('../validation');
const { requireAuth, STAFF } = require('../auth');
const { staffActor, recordEvent } = require('../events');
const { ROUTE_SELECT, getRoute, setRouteStops, applyStopAction } = require('../dispatch');

const router = express.Router();
router.use(requireAuth(...STAFF));

// GET /routes?date=2026-11-13&driver_id=3, date defaults to today in Lagos.
router.get('/', asyncHandler(async (req, res) => {
  const f = parse(z.object({ date: isoDate.optional(), driver_id: id.optional() }), req.query);
  const { rows } = await pool.query(
    `SELECT x.*, c.stop_count, c.done_count FROM (${ROUTE_SELECT}) x
     LEFT JOIN LATERAL (
       SELECT count(*) AS stop_count,
              count(*) FILTER (WHERE status IN ('completed', 'skipped')) AS done_count
       FROM stops WHERE route_id = x.id) c ON true
     WHERE x.route_date = COALESCE($1::date, ${TODAY_SQL})
       AND ($2::bigint IS NULL OR x.driver_id = $2)
     ORDER BY x.id`,
    [f.date ?? null, f.driver_id ?? null],
  );
  res.json(rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json(await getRoute(pool, idParam(req)));
}));

const createRoute = z.object({
  driver_id: id,
  vehicle_id: id.nullable().optional(),
  route_date: isoDate.optional(),
});

// The vehicle defaults to the driver's assigned vehicle.
router.post('/', asyncHandler(async (req, res) => {
  const b = parse(createRoute, req.body);
  const route = await withTransaction(async (db) => {
    const { rows: d } = await db.query('SELECT vehicle_id, status FROM drivers WHERE id = $1', [b.driver_id]);
    if (!d[0]) throw new HttpError(400, 'Driver not found');
    if (d[0].status !== 'active') throw new HttpError(409, 'Driver is inactive');
    const vehicleId = b.vehicle_id !== undefined ? b.vehicle_id : d[0].vehicle_id;
    const { rows } = await db.query(
      `INSERT INTO routes (driver_id, vehicle_id, route_date)
       VALUES ($1, $2, COALESCE($3::date, ${TODAY_SQL})) RETURNING id`,
      [b.driver_id, vehicleId, b.route_date ?? null],
    );
    return getRoute(db, rows[0].id);
  });
  res.status(201).json(route);
}));

// Change the driver or vehicle on a route that has not started.
router.patch('/:id', asyncHandler(async (req, res) => {
  const routeId = idParam(req);
  const b = parse(z.object({ driver_id: id.optional(), vehicle_id: id.nullable().optional() }), req.body);
  const route = await withTransaction(async (db) => {
    const { rows } = await db.query('SELECT status FROM routes WHERE id = $1 FOR UPDATE', [routeId]);
    if (!rows[0]) throw new HttpError(404, 'Route not found');
    if (b.driver_id !== undefined && rows[0].status !== 'planned') {
      throw new HttpError(409, 'The driver cannot change once the route has started');
    }
    await db.query(
      `UPDATE routes SET driver_id = COALESCE($2, driver_id),
         vehicle_id = CASE WHEN $3::boolean THEN $4::bigint ELSE vehicle_id END
       WHERE id = $1`,
      [routeId, b.driver_id ?? null, b.vehicle_id !== undefined, b.vehicle_id ?? null],
    );
    return getRoute(db, routeId);
  });
  res.json(route);
}));

// Manual assignment: the dispatcher sends the full ordered list of stop
// ids for this route. Stops left out go back to unassigned.
router.put('/:id/stops', asyncHandler(async (req, res) => {
  const routeId = idParam(req);
  const { stop_ids: stopIds } = parse(z.object({ stop_ids: z.array(id).max(200) }), req.body);
  const route = await withTransaction(async (db) => {
    await setRouteStops(db, routeId, stopIds, staffActor(req));
    return getRoute(db, routeId);
  });
  res.json(route);
}));

// Only routes where no stop has been started can be deleted. Their orders
// go back to pending.
// POST /routes/stops/:id/status { action } : a dispatcher records a stop
// update for the driver, for example when the driver phones in. Same
// rules as the driver app; the event is recorded as done by dispatch.
router.post('/stops/:id/status', asyncHandler(async (req, res) => {
  const stopId = parse(id, req.params.id);
  const body = parse(z.object({ action: z.enum(['arrive', 'start', 'complete', 'skip']) }).strict(), req.body);
  const route = await withTransaction(async (db) => {
    const r = await applyStopAction(db, stopId, body, { type: 'user', id: req.user.id });
    return getRoute(db, r.routeId);
  });
  res.json(route);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const routeId = idParam(req);
  await withTransaction(async (db) => {
    const { rows } = await db.query('SELECT id FROM routes WHERE id = $1 FOR UPDATE', [routeId]);
    if (!rows[0]) throw new HttpError(404, 'Route not found');
    const { rows: started } = await db.query(
      "SELECT 1 FROM stops WHERE route_id = $1 AND status <> 'pending' LIMIT 1",
      [routeId],
    );
    if (started[0]) throw new HttpError(409, 'Route has started stops and cannot be deleted');
    const { rows: orders } = await db.query(
      `UPDATE orders SET status = 'pending'
       WHERE status = 'assigned' AND id IN (SELECT order_id FROM stops WHERE route_id = $1)
       RETURNING id`,
      [routeId],
    );
    for (const o of orders) {
      await recordEvent(db, { orderId: o.id, type: 'unassigned', ...staffActor(req) });
    }
    await db.query('UPDATE stops SET route_id = NULL, sequence_number = NULL WHERE route_id = $1', [routeId]);
    await db.query('DELETE FROM routes WHERE id = $1', [routeId]);
  });
  res.status(204).end();
}));

module.exports = router;
