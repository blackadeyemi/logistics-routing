const { Pool, types } = require('pg');

// Return NUMERIC as a JS number (capacity_kg) and DATE as a plain
// YYYY-MM-DD string so route dates never shift with the server timezone.
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
// BIGINT ids and counts as numbers. Safe while values stay below 2^53.
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number(v)));
types.setTypeParser(types.builtins.DATE, (v) => v);

const pool = new Pool({
  host: process.env.PG_HOST,
  port: process.env.PG_PORT,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  max: 10,
});

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Operators are in Lagos, so "today" is always the Lagos calendar day.
const TODAY_SQL = "(now() AT TIME ZONE 'Africa/Lagos')::date";

module.exports = { pool, withTransaction, TODAY_SQL };
