// AI settings: the Anthropic key is write-only, stored encrypted, and
// checked through service-python. A stand-in for service-python records
// what api-node sends, so no test ever calls Anthropic.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const bcrypt = require('bcrypt');

const REAL_KEY = 'sk-ant-api03-testKEY_abcdefghijklmnopqrstuvwxyz0123';
const GOOD = 'sk-ant-api03-goodKEY_abcdefghijklmnopqrstuvwxyz9876';

let ctx;
let api;
let admin;
let staff;
let fake;
const seen = [];

before(async () => {
  // Stand-in service-python: accepts GOOD, rejects anything else like the
  // real service does for a key Anthropic refuses.
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const key = req.headers['x-anthropic-api-key'];
      seen.push({ path: req.url, key });
      res.setHeader('Content-Type', 'application/json');
      if (key === GOOD) {
        res.end(JSON.stringify({ ok: true, models: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }] }));
      } else {
        res.statusCode = 400;
        res.end(JSON.stringify({ detail: { code: 'invalid_key', message: 'Anthropic rejected this API key.' } }));
      }
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));

  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LLM_MODEL;
  process.env.PYTHON_SERVICE_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

  const { setup } = require('../test-support/setup');
  ctx = await setup();
  api = request(ctx.app);
  const hash = await bcrypt.hash('password123', 10);
  await ctx.pool.query(
    `INSERT INTO users (email, password_hash, full_name, role) VALUES
     ('admin@example.com', $1, 'Admin', 'admin'),
     ('dispatcher@example.com', $1, 'Dispatcher', 'dispatcher')`,
    [hash],
  );
  admin = (await api.post('/auth/login').send({ email: 'admin@example.com', password: 'password123' })).body.token;
  staff = (await api.post('/auth/login').send({ email: 'dispatcher@example.com', password: 'password123' })).body.token;
});

after(async () => {
  await ctx.teardown();
  fake.close();
});

const as = (token) => ({ Authorization: `Bearer ${token}` });

test('the Anthropic key is stored encrypted and never returned', async () => {
  const empty = await api.get('/settings').set(as(admin));
  assert.equal(empty.body.ai.api_key_set, false);
  assert.equal(empty.body.ai.key_source, 'none');
  assert.equal(empty.body.ai.can_save_secrets, true);

  const denied = await api.put('/settings').set(as(staff)).send({ ai: { api_key: REAL_KEY } });
  assert.equal(denied.status, 403);

  const bad = await api.put('/settings').set(as(admin)).send({ ai: { api_key: 'not-a-key' } });
  assert.equal(bad.status, 400);
  const badModel = await api.put('/settings').set(as(admin)).send({ ai: { model: 'gpt-5' } });
  assert.equal(badModel.status, 400);

  const saved = await api.put('/settings').set(as(admin)).send({ ai: { api_key: REAL_KEY, model: 'claude-opus-5-5' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ai.api_key_set, true);
  assert.equal(saved.body.ai.key_source, 'settings');
  assert.equal(saved.body.ai.model, 'claude-opus-5-5');
  assert.equal(saved.body.ai.api_key_hint, 'sk-ant-…0123');

  // The key appears in no response, for admins or dispatchers.
  for (const token of [admin, staff]) {
    const res = await api.get('/settings').set(as(token));
    assert.ok(!JSON.stringify(res.body).includes(REAL_KEY));
  }
  // And not in the database in plain text.
  const { rows } = await ctx.pool.query("SELECT value FROM app_settings WHERE key = 'anthropic_api_key'");
  assert.match(rows[0].value, /^enc:v1:/);
  assert.ok(!rows[0].value.includes(REAL_KEY));

  // Saving only the model keeps the key.
  const modelOnly = await api.put('/settings').set(as(admin)).send({ ai: { model: 'claude-sonnet-5-5' } });
  assert.equal(modelOnly.body.ai.model, 'claude-sonnet-5-5');
  assert.equal(modelOnly.body.ai.api_key_hint, 'sk-ant-…0123');
});

test('a changed encryption key makes the saved key unreadable, not a crash', async () => {
  const original = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  try {
    const res = await api.get('/settings').set(as(admin));
    assert.equal(res.status, 200);
    assert.equal(res.body.ai.api_key_set, false);
    assert.equal(res.body.ai.key_unreadable, true);
  } finally {
    process.env.SETTINGS_ENCRYPTION_KEY = original;
  }
});

test('checking a key goes through service-python', async () => {
  const good = await api.post('/settings/ai/check').set(as(admin)).send({ api_key: GOOD });
  assert.equal(good.status, 200);
  assert.equal(good.body.models[0].id, 'claude-opus-5-5');
  assert.equal(seen.at(-1).path, '/ai/models');
  assert.equal(seen.at(-1).key, GOOD);

  // No key in the body: the saved key is checked (and rejected by the stand-in).
  const saved = await api.post('/settings/ai/check').set(as(admin)).send({});
  assert.equal(saved.status, 400);
  assert.equal(saved.body.details.code, 'invalid_key');
  assert.equal(seen.at(-1).key, REAL_KEY);

  const denied = await api.post('/settings/ai/check').set(as(staff)).send({ api_key: GOOD });
  assert.equal(denied.status, 403);
});

test('removing the key turns AI off, with the .env key as fallback', async () => {
  const removed = await api.put('/settings').set(as(admin)).send({ ai: { api_key: '' } });
  assert.equal(removed.body.ai.api_key_set, false);
  assert.equal(removed.body.ai.key_source, 'none');

  process.env.ANTHROPIC_API_KEY = GOOD;
  try {
    const fallback = await api.get('/settings').set(as(admin));
    assert.equal(fallback.body.ai.key_source, 'env');
    assert.equal(fallback.body.ai.api_key_hint, 'sk-ant-…9876');
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});
