// Endpoints the driver PWA calls. Every query is scoped to the logged-in
// driver, so a driver can only see and change their own routes.
const express = require('express');
const { pool, withTransaction, TODAY_SQL } = require('../db');
const { asyncHandler, HttpError } = require('../errors');
const { z, parse, id, isoDate } = require('../validation');
const { requireAuth } = require('../auth');
const { getRoute, applyDriverAction } = require('../dispatch');

const router = express.Router();
router.use(requireAuth('driver'));

// GET /driver/route?date=YYYY-MM-DD, today in Lagos by default.
// Returns { route: null } when nothing is planned, so the PWA can cache
// an empty day as well as a full one.
router.get('/route', asyncHandler(async (req, res) => {
  const { date } = parse(z.object({ date: isoDate.optional() }), req.query);
  const { rows } = await pool.query(
    `SELECT id FROM routes WHERE driver_id = $1 AND route_date = COALESCE($2::date, ${TODAY_SQL})`,
    [req.user.id, date ?? null],
  );
  if (!rows[0]) return res.json({ route: null });
  return res.json({ route: await getRoute(pool, rows[0].id) });
}));

const actionBody = z.object({
  action: z.enum(['arrive', 'start', 'complete', 'skip']),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  client_event_id: z.string().min(8).max(64).optional(),
});

// POST /driver/stops/:id/status
// { action, occurred_at?, client_event_id? }
// occurred_at is when the driver tapped, for updates sent from the
// offline queue. Replies with the updated route.
router.post('/stops/:id/status', asyncHandler(async (req, res) => {
  const stopId = parse(id, req.params.id);
  const body = parse(actionBody, req.body);
  const result = await withTransaction(async (db) => {
    const r = await applyDriverAction(db, req.user.id, stopId, body);
    return { ...r, route: await getRoute(db, r.routeId) };
  });
  if (!result.route) throw new HttpError(404, 'Route not found');
  res.json({ replayed: result.replayed, route: result.route });
}));

module.exports = router;
