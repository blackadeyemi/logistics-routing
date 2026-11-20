// Endpoints the driver PWA calls. Every query is scoped to the logged-in
// driver, so a driver can only see and change their own routes.
const express = require('express');
const { pool, withTransaction, TODAY_SQL } = require('../db');
const { asyncHandler, HttpError } = require('../errors');
const { z, parse, id, isoDate } = require('../validation');
const { requireAuth } = require('../auth');
const { getRoute, applyDriverAction } = require('../dispatch');
const { afterStopUpdate } = require('../stopEvents');
const { publish } = require('../realtime');
const { routeEta } = require('../eta');

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
  afterStopUpdate(result.route, stopId, body.action, result.replayed);
  res.json({ replayed: result.replayed, route: result.route });
}));

const point = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy_m: z.number().min(0).max(100_000).nullable().optional(),
  speed_mps: z.number().min(0).max(100).nullable().optional(),
  heading_deg: z.number().min(0).max(360).nullable().optional(),
  app_visible: z.boolean().optional(),
  recorded_at: z.string().datetime({ offset: true }),
});

// POST /driver/locations { points: [...] }
// Positions from the driver app, in batches: the app queues them while
// offline and sends them later, so each keeps the time it was taken.
// Positions older than 48 hours or in the future are ignored, and a
// repeated point (same driver and time) is a no-op. Replies with how many
// were stored, and pushes the newest one to the dashboard with fresh ETAs.
router.post('/locations', asyncHandler(async (req, res) => {
  const { points } = parse(z.object({ points: z.array(point).min(1).max(500) }).strict(), req.body);
  const now = Date.now();
  const valid = points.filter((p) => {
    const t = new Date(p.recorded_at).getTime();
    return t <= now + 5 * 60_000 && t >= now - 48 * 3600_000;
  });
  if (!valid.length) return res.json({ accepted: 0 });
  const { rows } = await pool.query(
    `INSERT INTO driver_locations (driver_id, route_id, location, accuracy_m, speed_mps, heading_deg, app_visible, recorded_at)
     SELECT $1::int,
            (SELECT r.id FROM routes r WHERE r.driver_id = $1::int AND r.route_date = (p.at AT TIME ZONE 'Africa/Lagos')::date),
            ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326)::geography, p.acc, p.speed, p.heading, p.visible, p.at
     FROM unnest($2::float8[], $3::float8[], $4::real[], $5::real[], $6::real[], $7::boolean[], $8::timestamptz[])
          AS p(lat, lng, acc, speed, heading, visible, at)
     ON CONFLICT (driver_id, recorded_at) DO NOTHING
     RETURNING route_id, recorded_at`,
    [req.user.id, valid.map((p) => p.lat), valid.map((p) => p.lng), valid.map((p) => p.accuracy_m ?? null),
      valid.map((p) => p.speed_mps ?? null), valid.map((p) => p.heading_deg ?? null), valid.map((p) => p.app_visible ?? null),
      valid.map((p) => p.recorded_at)],
  );
  res.json({ accepted: rows.length });

  // Only the newest stored point matters to the live map.
  const newest = valid.reduce((a, b) => (new Date(b.recorded_at) > new Date(a.recorded_at) ? b : a));
  const stored = rows.find((r) => new Date(r.recorded_at).getTime() === new Date(newest.recorded_at).getTime());
  if (stored) {
    const eta = stored.route_id ? await routeEta(stored.route_id).catch(() => null) : null;
    publish({
      type: 'location', driver_id: req.user.id, route_id: stored.route_id ? Number(stored.route_id) : null,
      location: { lat: newest.lat, lng: newest.lng, accuracy_m: newest.accuracy_m ?? null }, recorded_at: newest.recorded_at,
      eta: eta?.stops ?? [],
    });
  }
  return undefined;
}));

module.exports = router;
