// Live view data for the dashboard (Phase 4): where drivers are, their
// stops and ETAs, and how well tracking is working.
const express = require('express');
const { pool, TODAY_SQL } = require('../db');
const { asyncHandler } = require('../errors');
const { z, parse, isoDate } = require('../validation');
const { requireAuth, STAFF } = require('../auth');
const { getRouteStops } = require('../dispatch');
const { routeEta, latestLocation } = require('../eta');

const router = express.Router();
router.use(requireAuth(...STAFF));

// The interval the driver app sends at while a route is active.
const EXPECTED_INTERVAL_S = 30;

async function dayOf(date) {
  const { rows } = await pool.query(`SELECT COALESCE($1::date, ${TODAY_SQL})::text AS d`, [date ?? null]);
  return rows[0].d;
}

// GET /live?date= : every route of the day with its driver's last position,
// stops and ETAs. The dashboard loads this once, then follows /ws events.
router.get('/', asyncHandler(async (req, res) => {
  const { date } = parse(z.object({ date: isoDate.optional() }), req.query);
  const day = await dayOf(date);
  const { rows: routes } = await pool.query(
    `SELECT r.id, r.status, r.driver_id, d.name AS driver, d.phone AS driver_phone, v.type AS vehicle_type, v.plate_number
     FROM routes r LEFT JOIN drivers d ON d.id = r.driver_id LEFT JOIN vehicles v ON v.id = r.vehicle_id
     WHERE r.route_date = $1 ORDER BY r.id`,
    [day],
  );
  const out = [];
  for (const r of routes) {
    const [stops, eta, last] = await Promise.all([getRouteStops(pool, r.id), routeEta(r.id), r.driver_id ? latestLocation(pool, r.driver_id) : null]);
    const etaBy = new Map(eta.stops.map((e) => [e.stop_id, e]));
    out.push({
      route_id: Number(r.id), status: r.status, driver_id: r.driver_id, driver: r.driver, driver_phone: r.driver_phone,
      vehicle: r.vehicle_type ? `${r.vehicle_type} ${r.plate_number}` : null,
      location: last ? { lat: Number(last.lat), lng: Number(last.lng), accuracy_m: last.accuracy_m, recorded_at: last.recorded_at, age_s: last.age_s } : null,
      eta_from: eta.from,
      stops: stops.map((s) => ({
        stop_id: Number(s.id), n: s.sequence_number, type: s.stop_type, status: s.status, order_id: Number(s.order_id),
        customer: s.customer_name, address: s.address, location: s.location, completed_at: s.completed_at,
        eta: etaBy.get(Number(s.id))?.eta ?? null, eta_minutes: etaBy.get(Number(s.id))?.minutes ?? null,
      })),
    });
  }
  res.json({ date: day, routes: out });
}));

// GET /live/tracking-quality?date= : how much location data actually
// arrived per driver, and how much of the loss happened while the app was
// in the background. This is the measurement that decides Phase 7.
router.get('/tracking-quality', asyncHandler(async (req, res) => {
  const { date } = parse(z.object({ date: isoDate.optional() }), req.query);
  const day = await dayOf(date);
  const { rows } = await pool.query(
    `SELECT l.driver_id, d.name, l.recorded_at, l.received_at, l.app_visible, l.accuracy_m
     FROM driver_locations l JOIN drivers d ON d.id = l.driver_id
     WHERE (l.recorded_at AT TIME ZONE 'Africa/Lagos')::date = $1
     ORDER BY l.driver_id, l.recorded_at`,
    [day],
  );
  const by = new Map();
  for (const p of rows) {
    if (!by.has(p.driver_id)) by.set(p.driver_id, { driver_id: p.driver_id, driver: p.name, points: [] });
    by.get(p.driver_id).points.push(p);
  }
  const drivers = [...by.values()].map(({ driver_id: driverId, driver, points }) => {
    const t = points.map((p) => new Date(p.recorded_at).getTime());
    const spanS = (t.at(-1) - t[0]) / 1000;
    let covered = 0;
    let longest = 0;
    let gaps = 0;
    let gapS = 0;
    let hiddenGapS = 0;
    for (let i = 1; i < t.length; i += 1) {
      const d = (t[i] - t[i - 1]) / 1000;
      covered += Math.min(d, EXPECTED_INTERVAL_S * 2);
      longest = Math.max(longest, d);
      if (d > EXPECTED_INTERVAL_S * 3) {
        gaps += 1;
        gapS += d;
        // A gap that starts or ends on a point taken in the background is
        // put down to the browser pausing the app.
        if (points[i - 1].app_visible === false || points[i].app_visible === false) hiddenGapS += d;
      }
    }
    const late = points.filter((p) => new Date(p.received_at) - new Date(p.recorded_at) > 60_000).length;
    return {
      driver_id: driverId, driver, points: points.length,
      first: points[0].recorded_at, last: points.at(-1).recorded_at,
      tracked_minutes: Math.round(spanS / 60),
      expected_points: Math.max(1, Math.floor(spanS / EXPECTED_INTERVAL_S) + 1),
      coverage: spanS > 0 ? Math.round((covered / spanS) * 1000) / 1000 : 1,
      gaps_over_90s: gaps,
      longest_gap_s: Math.round(longest),
      gap_minutes: Math.round(gapS / 60),
      gap_minutes_while_hidden: Math.round(hiddenGapS / 60),
      hidden_points: points.filter((p) => p.app_visible === false).length,
      sent_late_from_queue: late,
      median_accuracy_m: points.map((p) => p.accuracy_m).filter((a) => a != null).sort((a, b) => a - b)[Math.floor(points.length / 2)] ?? null,
    };
  });
  res.json({ date: day, expected_interval_s: EXPECTED_INTERVAL_S, drivers });
}));

module.exports = router;
