// WhatsApp intake through api-node, and stop notes on orders and routes.
// A stand-in for service-python returns a fixed draft; no Anthropic calls.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const bcrypt = require('bcrypt');

const KEY = 'sk-ant-api03-intakeKEY_abcdefghijklmnopqrstuvwxyz01';
let ctx;
let api;
let admin;
let staff;
let fake;
let lastBody;
let failNext = false;

const DRAFT = {
  draft: {
    customer_name: 'Chinedu Okeke', customer_phone: '+2348034567890',
    pickup_address: '23 Allen Avenue, Ikeja', pickup_notes: null,
    dropoff_address: '5 Admiralty Way, Lekki Phase 1', dropoff_notes: 'Call on arrival. Collect 15,000 naira.',
  },
  phone_valid: true, missing: [], warnings: [],
  usage: { input_tokens: 1600, output_tokens: 150, cache_read_tokens: 0, duration_ms: 4200, model: 'claude-sonnet-5-5' },
};

before(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastBody = { path: req.url, key: req.headers['x-anthropic-api-key'], json: JSON.parse(body || '{}') };
      res.setHeader('Content-Type', 'application/json');
      if (failNext) {
        failNext = false;
        res.statusCode = 422;
        res.end(JSON.stringify({ detail: { code: 'refusal', message: 'The model declined this message.' } }));
        return;
      }
      res.end(JSON.stringify(DRAFT));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LLM_MODEL;
  process.env.PYTHON_SERVICE_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');

  const { setup } = require('../test-support/setup');
  ctx = await setup();
  api = request(ctx.app);
  const hash = await bcrypt.hash('password123', 10);
  await ctx.pool.query(
    `INSERT INTO users (email, password_hash, full_name, role) VALUES
     ('admin@example.com', $1, 'Admin', 'admin'), ('dispatcher@example.com', $1, 'Dispatcher', 'dispatcher')`,
    [hash],
  );
  admin = (await api.post('/auth/login').send({ email: 'admin@example.com', password: 'password123' })).body.token;
  staff = (await api.post('/auth/login').send({ email: 'dispatcher@example.com', password: 'password123' })).body.token;
});

after(async () => {
  await ctx.teardown();
  fake.close();
});

const as = (t) => ({ Authorization: `Bearer ${t}` });
const MESSAGE = 'Pls pickup from 23 Allen Avenue Ikeja, deliver to Chinedu 0803 456 7890 at 5 Admiralty way Lekki';

test('intake needs a configured key and model', async () => {
  const anon = await api.post('/ai/extract-order').send({ message: MESSAGE });
  assert.equal(anon.status, 401);
  const res = await api.post('/ai/extract-order').set(as(staff)).send({ message: MESSAGE });
  assert.equal(res.status, 409);
  assert.equal(res.body.details.code, 'not_configured');
});

test('a dispatcher turns a message into a draft, with usage logged', async () => {
  await api.put('/settings').set(as(admin)).send({ ai: { api_key: KEY, model: 'claude-sonnet-5-5' } });

  const empty = await api.post('/ai/extract-order').set(as(staff)).send({ message: '  ' });
  assert.equal(empty.status, 400);

  const res = await api.post('/ai/extract-order').set(as(staff)).send({ message: MESSAGE });
  assert.equal(res.status, 200);
  assert.equal(res.body.draft.customer_name, 'Chinedu Okeke');
  assert.equal(res.body.model, 'claude-sonnet-5-5');
  // api-node sent the decrypted key and the chosen model, not the browser.
  assert.equal(lastBody.path, '/ai/extract-order');
  assert.equal(lastBody.key, KEY);
  assert.deepEqual(lastBody.json, { model: 'claude-sonnet-5-5', message: MESSAGE });

  const { rows } = await ctx.pool.query('SELECT feature, model, input_tokens, output_tokens, ok FROM ai_usage');
  assert.deepEqual(rows, [{ feature: 'extract_order', model: 'claude-sonnet-5-5', input_tokens: 1600, output_tokens: 150, ok: true }]);
});

test('a refusal comes back as a readable error and is logged as failed', async () => {
  failNext = true;
  const res = await api.post('/ai/extract-order').set(as(staff)).send({ message: MESSAGE });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /declined/);
  const { rows } = await ctx.pool.query('SELECT ok FROM ai_usage ORDER BY id DESC LIMIT 1');
  assert.equal(rows[0].ok, false);
});

test('stop notes are saved with the order and reach the route', async () => {
  const created = await api.post('/orders').set(as(staff)).send({
    customer_name: 'Chinedu Okeke', customer_phone: '0803 456 7890',
    pickup_address: '23 Allen Avenue, Ikeja', dropoff_address: '5 Admiralty Way, Lekki Phase 1',
    pickup_notes: '  ', dropoff_notes: 'Call on arrival. Collect 15,000 naira.',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.pickup_notes, null);
  assert.equal(created.body.dropoff_notes, 'Call on arrival. Collect 15,000 naira.');

  const patched = await api.patch(`/orders/${created.body.id}`).set(as(staff)).send({ pickup_notes: 'Ask for Mama Ngozi' });
  assert.equal(patched.body.pickup_notes, 'Ask for Mama Ngozi');
  assert.equal(patched.body.dropoff_notes, 'Call on arrival. Collect 15,000 naira.');

  const driver = await api.post('/drivers').set(as(staff)).send({ name: 'Notes Driver', phone: '08020009999' });
  const route = await api.post('/routes').set(as(staff)).send({ driver_id: driver.body.id });
  const stops = await api.put(`/routes/${route.body.id}/stops`).set(as(staff))
    .send({ stop_ids: [created.body.pickup_stop_id, created.body.dropoff_stop_id] });
  assert.equal(stops.status, 200);
  assert.deepEqual(stops.body.stops.map((s) => s.notes), ['Ask for Mama Ngozi', 'Call on arrival. Collect 15,000 naira.']);
});
