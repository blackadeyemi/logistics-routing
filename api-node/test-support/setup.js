// Each test file gets its own throwaway database built from db/init, so
// files can run in parallel and never touch dev data. Needs a Postgres
// with PostGIS reachable from the host, for example the compose service
// on localhost:5432.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const base = {
  host: process.env.TEST_PG_HOST || 'localhost',
  port: Number(process.env.TEST_PG_PORT || 5432),
  user: process.env.TEST_PG_USER || process.env.PG_USER || 'appuser',
  password: process.env.TEST_PG_PASSWORD || process.env.PG_PASSWORD || 'apppass',
};
const adminDb = process.env.TEST_PG_ADMIN_DB || 'postgres';

async function createTestDatabase(name) {
  const admin = new Client({ ...base, database: adminDb });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const db = new Client({ ...base, database: name });
  await db.connect();
  const dir = path.join(__dirname, '..', '..', 'db', 'init');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.query(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  await db.end();
}

async function dropTestDatabase(name) {
  const admin = new Client({ ...base, database: adminDb });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}

// Sets env for src/db.js, builds the database, then loads the app.
// Must run before anything requires src/.
async function setup() {
  const name = `logistics_test_${process.pid}`;
  Object.assign(process.env, {
    PG_HOST: base.host,
    PG_PORT: String(base.port),
    PG_USER: base.user,
    PG_PASSWORD: base.password,
    PG_DATABASE: name,
    JWT_SECRET: 'test-secret-that-is-long-enough-for-the-check',
  });
  await createTestDatabase(name);
  const app = require('../src/app');
  const { pool } = require('../src/db');
  return {
    app,
    pool,
    async teardown() {
      await pool.end();
      await dropTestDatabase(name);
    },
  };
}

module.exports = { setup };
