// Public tracking for customers (Phase 4). No login: the order's tracking
// token, sent by SMS, is the only key. Everything here is limited to what
// the customer needs: no phone numbers, no other customers, no full names,
// and the driver's position only while they are on the way to this
// customer and the position is recent.
const express = require('express');
const { pool } = require('../db');
const { asyncHandler, HttpError } = require('../errors');
const { routeEta, latestLocation } = require('../eta');
const { smsConfig } = require('../sms');

const router = express.Router();

// A small limit per client and link; the tracking page polls about once a
// minute. Keyed on the path too, because behind a proxy every customer can
// share one address. Tokens are 122 random bits, so guessing is not the
// threat this guards against: a misbehaving page or script is.
const hits = new Map();
const LIMIT = 30;
router.use((req, res, next) => {
  const key = `${req.ip} ${req.path}`;
  const now = Date.now();
  const h = hits.get(key) ?? { n: 0, reset: now + 60_000 };
  if (now > h.reset) {
    h.n = 0;
    h.reset = now + 60_000;
  }
  h.n += 1;
  hits.set(key, h);
  if (hits.size > 10_000) hits.clear();
  if (h.n > LIMIT) return next(new HttpError(429, 'Too many requests. Try again in a minute.'));
  return next();
});

const PUBLIC_EVENTS = ['created', 'assigned', 'picked_up', 'en_route', 'delivered', 'skipped', 'cancelled'];
const firstName = (name) => (name || '').trim().split(/\s+/)[0] || null;

// GET /public/track/:token
router.get('/track/:token', asyncHandler(async (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[0-9a-f]{32}$/.test(token)) throw new HttpError(404, 'Tracking link not found');
  const { rows } = await pool.query(
    `SELECT o.id, o.customer_name, o.status, o.dropoff_address, o.dropoff_after::text AS dropoff_after, o.dropoff_before::text AS dropoff_before,
            ds.id AS dropoff_stop_id, ds.route_id, ds.status AS dropoff_status, r.driver_id, d.name AS driver_name, v.type AS vehicle_type
     FROM orders o
     JOIN stops ds ON ds.order_id = o.id AND ds.stop_type = 'dropoff'
     LEFT JOIN routes r ON r.id = ds.route_id
     LEFT JOIN drivers d ON d.id = r.driver_id
     LEFT JOIN vehicles v ON v.id = r.vehicle_id
     WHERE o.tracking_token = $1`,
    [token],
  );
  const o = rows[0];
  if (!o) throw new HttpError(404, 'Tracking link not found');

  const { rows: events } = await pool.query(
    `SELECT event_type, occurred_at FROM order_events WHERE order_id = $1 AND event_type = ANY($2) ORDER BY occurred_at, id`,
    [o.id, PUBLIC_EVENTS],
  );

  let eta = null;
  let driver = null;
  if (o.route_id && ['assigned', 'picked_up', 'en_route'].includes(o.status)) {
    const e = await routeEta(o.route_id);
    const mine = e.stops.find((s) => s.stop_id === Number(o.dropoff_stop_id));
    if (mine) eta = { at: mine.eta, minutes: mine.minutes, based_on: e.from };
    driver = { first_name: firstName(o.driver_name), vehicle: o.vehicle_type };
    if (o.status === 'en_route' && o.driver_id) {
      const loc = await latestLocation(pool, o.driver_id);
      if (loc && loc.age_s <= 10 * 60) driver.location = { lat: Number(loc.lat), lng: Number(loc.lng), age_s: loc.age_s };
    }
  }

  const cfg = await smsConfig();
  // The Maps key is a browser key, restricted by referrer in Google Cloud,
  // so the public page may use it to draw the driver's position.
  const { rows: mk } = await pool.query(
    "SELECT key, value FROM app_settings WHERE key IN ('google_maps_api_key', 'google_maps_map_id')",
  );
  const maps = Object.fromEntries(mk.map((r) => [r.key, r.value]));
  res.set('Cache-Control', 'no-store');
  res.json({
    company: cfg.company,
    order_number: Number(o.id),
    customer_first_name: firstName(o.customer_name),
    status: o.status,
    dropoff_address: o.dropoff_address,
    window: o.dropoff_after || o.dropoff_before ? { after: o.dropoff_after?.slice(0, 5) ?? null, before: o.dropoff_before?.slice(0, 5) ?? null } : null,
    failed_attempt: o.dropoff_status === 'skipped',
    eta,
    driver,
    events: events.map((e) => ({ type: e.event_type, at: e.occurred_at })),
    maps: maps.google_maps_api_key ? { api_key: maps.google_maps_api_key, map_id: maps.google_maps_map_id ?? '' } : null,
  });
}));

module.exports = router;
