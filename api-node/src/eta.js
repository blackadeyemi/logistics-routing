// ETAs for the stops a driver has not finished yet (Phase 4).
//
// From the driver's latest position (or, without a recent one, from the
// first remaining stop, starting now) through the remaining stops in route
// order: travel time from the distance module plus a fixed time at each
// stop. Recalculated whenever a new position or stop update arrives, so it
// tracks the driver. Straight-line travel times until Phase 5 adds roads.
const { pool } = require('./db');
const { distanceMatrix } = require('./distance');

const SERVICE_S = 5 * 60;
const FRESH_S = 15 * 60; // an older position is not trusted as "where the driver is"

async function latestLocation(db, driverId) {
  const { rows } = await db.query(
    `SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng, accuracy_m, recorded_at,
            EXTRACT(EPOCH FROM now() - recorded_at)::int AS age_s
     FROM driver_locations WHERE driver_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
    [driverId],
  );
  return rows[0] ?? null;
}

/**
 * Returns { from: 'driver' | 'first_stop' | null, stops: [{ stop_id, eta, minutes }] }
 * for the route's pending and arrived stops, in order.
 */
async function routeEta(routeId, db = pool) {
  const { rows: route } = await db.query('SELECT driver_id FROM routes WHERE id = $1', [routeId]);
  if (!route[0]) return { from: null, stops: [] };
  const { rows: stops } = await db.query(
    `SELECT id, status, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
     FROM stops WHERE route_id = $1 AND status IN ('pending', 'arrived') ORDER BY sequence_number, id`,
    [routeId],
  );
  const located = stops.filter((s) => s.lat != null);
  if (!located.length) return { from: null, stops: [] };

  const here = route[0].driver_id ? await latestLocation(db, route[0].driver_id) : null;
  const fromDriver = here && here.age_s <= FRESH_S;
  const points = [...(fromDriver ? [{ lat: Number(here.lat), lng: Number(here.lng) }] : []), ...located.map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) }))];
  const m = await distanceMatrix(points);

  let t = Date.now();
  const out = [];
  located.forEach((s, i) => {
    const idx = fromDriver ? i + 1 : i;
    if (idx > 0) t += m.durations_s[idx - 1][idx] * 1000;
    // Already at this stop: due now. Otherwise arrival, then the stop time
    // before moving on.
    const eta = s.status === 'arrived' ? Date.now() : t;
    out.push({ stop_id: Number(s.id), eta: new Date(eta).toISOString(), minutes: Math.max(0, Math.round((eta - Date.now()) / 60000)) });
    t = Math.max(t, eta) + SERVICE_S * 1000;
  });
  return { from: fromDriver ? 'driver' : 'first_stop', stops: out };
}

module.exports = { routeEta, latestLocation, FRESH_S };
