// Distance and travel-time matrices between stops, behind one interface so
// Phase 5 can swap straight lines for road distances (OSRM) without the
// optimizer or the comparison changing.
//
//   const m = await distanceMatrix(points)  // points: [{ lat, lng }]
//   m.distances_m[i][j], m.durations_s[i][j], m.provider
//
// DISTANCE_PROVIDER picks the implementation; only "straight_line" exists.
const { pool } = require('./db');

// Lagos roads are not straight: a detour factor turns a straight line into
// a rough road distance for timing, and an average speed in traffic turns
// that into minutes. Used only for time windows, never for the distance
// the optimizer minimises or the plans are compared on.
const DETOUR = 1.35;
const AVG_SPEED_KMH = 18;

async function straightLine(points) {
  const n = points.length;
  if (!n) return { distances_m: [], durations_s: [] };
  // One query: PostGIS geodesic distance for every pair.
  const { rows } = await pool.query(
    `WITH p AS (
       SELECT i, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography AS g
       FROM unnest($1::float8[], $2::float8[]) WITH ORDINALITY AS t(lat, lng, i)
     )
     SELECT a.i - 1 AS i, b.i - 1 AS j, round(ST_Distance(a.g, b.g))::int AS m
     FROM p a CROSS JOIN p b`,
    [points.map((p) => p.lat), points.map((p) => p.lng)],
  );
  const distances = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const r of rows) distances[r.i][r.j] = r.m;
  const durations = distances.map((row) => row.map((m) => Math.round((m * DETOUR) / (AVG_SPEED_KMH / 3.6))));
  return { distances_m: distances, durations_s: durations };
}

const PROVIDERS = { straight_line: straightLine };

async function distanceMatrix(points) {
  const name = process.env.DISTANCE_PROVIDER || 'straight_line';
  const impl = PROVIDERS[name];
  if (!impl) throw new Error(`Unknown DISTANCE_PROVIDER ${name}`);
  return { ...(await impl(points)), provider: name };
}

module.exports = { distanceMatrix };
