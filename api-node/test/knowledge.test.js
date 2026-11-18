// Knowledge: SOP documents, chunking, stop-note indexing and hybrid search.
// A stand-in embedder (hashed bag of words) replaces the real model, so the
// test checks api-node's side: what gets indexed and how search ranks.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const bcrypt = require('bcrypt');

let ctx;
let api;
let admin;
let staff;
let fake;

function fakeVector(text) {
  const v = new Array(384).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 384;
    v[h] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

before(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { texts } = JSON.parse(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ vectors: texts.map(fakeVector) }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.PYTHON_SERVICE_URL = `http://127.0.0.1:${fake.address().port}`;
  const { setup } = require('../test-support/setup');
  ctx = await setup();
  api = request(ctx.app);
  const hash = await bcrypt.hash('password123', 10);
  await ctx.pool.query(
    `INSERT INTO users (email, password_hash, full_name, role) VALUES
     ('admin@example.com', $1, 'Admin', 'admin'), ('d@example.com', $1, 'Dee', 'dispatcher')`,
    [hash],
  );
  admin = (await api.post('/auth/login').send({ email: 'admin@example.com', password: 'password123' })).body.token;
  staff = (await api.post('/auth/login').send({ email: 'd@example.com', password: 'password123' })).body.token;
});

after(async () => {
  await ctx.teardown();
  fake.close();
});

const as = (t) => ({ Authorization: `Bearer ${t}` });
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

test('chunking keeps each section heading with its text', () => {
  const { chunkDocument } = require('../src/knowledge');
  const chunks = chunkDocument('Cash on delivery', '## Collecting payment\nCollect the exact amount.\n\n## When the customer cannot pay\nCall the dispatcher.');
  assert.deepEqual(chunks, [
    { title: 'Cash on delivery: Collecting payment', content: 'Collect the exact amount.' },
    { title: 'Cash on delivery: When the customer cannot pay', content: 'Call the dispatcher.' },
  ]);
});

test('admins write SOPs, dispatchers read and search them', async () => {
  const denied = await api.post('/knowledge/documents').set(as(staff)).send({ title: 'X', body: 'Y' });
  assert.equal(denied.status, 403);
  const created = await api.post('/knowledge/documents').set(as(admin)).send({
    title: 'Fragile items',
    body: '## Cakes\nCakes go on vans or keke, never on bikes.\n\n## Glass\nGlass must be wrapped by the seller.',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.chunks, 2);

  const hits = await api.get('/knowledge/search').set(as(staff)).query({ q: 'can a cake go on a bike' });
  assert.equal(hits.status, 200);
  assert.equal(hits.body[0].title, 'Fragile items: Cakes');
  assert.equal(hits.body[0].source_type, 'sop');

  const edited = await api.put(`/knowledge/documents/${created.body.id}`).set(as(admin)).send({ title: 'Fragile items', body: 'Only one section now.' });
  assert.equal(edited.body.chunks, 1);
  await api.delete(`/knowledge/documents/${created.body.id}`).set(as(admin)).expect(204);
  const stats = await api.get('/knowledge/stats').set(as(staff));
  assert.equal(stats.body.sop_chunks, 0);
});

test('stop notes are indexed with their address and found by keyword', async () => {
  const order = (await api.post('/orders').set(as(staff)).send({
    customer_name: 'Chuka Obi', customer_phone: '07055443322',
    pickup_address: '6 Olusoji Idowu Street, Ilupeju', dropoff_address: 'House 14, Road 5, Victoria Garden City, Ajah',
    dropoff_notes: 'Gate code 4471, tell security you are for Mr Obi.',
  })).body;
  await wait(300); // indexing runs after the response
  const hits = await api.get('/knowledge/search').set(as(staff)).query({ q: 'gate code Victoria Garden City', source: 'stop_note' });
  assert.equal(hits.body.length, 1);
  assert.equal(hits.body[0].order_id, order.id);
  assert.match(hits.body[0].title, /dropoff at House 14, Road 5, Victoria Garden City/);

  // Clearing the note removes it from search.
  await api.patch(`/orders/${order.id}`).set(as(staff)).send({ dropoff_notes: '' });
  await wait(300);
  const after = await api.get('/knowledge/search').set(as(staff)).query({ q: 'gate code', source: 'stop_note' });
  assert.equal(after.body.length, 0);
});
