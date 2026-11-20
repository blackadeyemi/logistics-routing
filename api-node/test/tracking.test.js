// Phase 4: driver locations, the WebSocket feed, ETAs, the public tracking
// page, customer SMS (outbox and a stand-in Termii), and tracking quality.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const bcrypt = require('bcrypt');
const WebSocket = require('ws');

let ctx;
let api;
let admin;
let staff;
let driverToken;
let server;
let wsUrl;
let termii;
let termiiCalls = [];
const ids = {};

before(async () => {
  termii = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      termiiCalls.push({ path: req.url, body: JSON.parse(body), headers: req.headers });
      res.setHeader('Content-Type', 'application/json');
      // Answers like Brevo on Brevo's path, like Termii otherwise.
      if (req.url === '/v3/transactionalSMS/send') {
        res.statusCode = 201;
        res.end(JSON.stringify({ messageId: 1511882900176220 }));
        return;
      }
      res.end(JSON.stringify({ code: 'ok', message_id: 123, message_id_str: '123', message: 'Successfully Sent' }));
    });
  });
  await new Promise((r) => termii.listen(0, '127.0.0.1', r));
  process.env.SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
  delete process.env.SMS_PROVIDER;
  const { setup } = require('../test-support/setup');
  ctx = await setup();
  api = request(ctx.app);
  const { attachWebSocket } = require('../src/realtime');
  server = http.createServer(ctx.app);
  attachWebSocket(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  wsUrl = `ws://127.0.0.1:${server.address().port}/ws`;

  const hash = await bcrypt.hash('password123', 10);
  await ctx.pool.query(
    `INSERT INTO users (email, password_hash, full_name, role) VALUES
     ('admin@example.com', $1, 'Admin', 'admin'), ('d@example.com', $1, 'Dee', 'dispatcher')`,
    [hash],
  );
  admin = (await api.post('/auth/login').send({ email: 'admin@example.com', password: 'password123' })).body.token;
  staff = (await api.post('/auth/login').send({ email: 'd@example.com', password: 'password123' })).body.token;
  const as = { Authorization: `Bearer ${staff}` };
  const bike = (await api.post('/vehicles').set(as).send({ type: 'bike', plate_number: 'LAG-9', capacity_kg: 20 })).body;
  ids.driver = (await api.post('/drivers').set(as).send({ name: 'Musa Abdullahi', phone: '08020000001', vehicle_id: bike.id, pin: '1234' })).body.id;
  driverToken = (await api.post('/auth/driver-login').send({ phone: '08020000001', pin: '1234' })).body.token;
  ids.order = (await api.post('/orders').set(as).send({
    customer_name: 'Chioma Okafor', customer_phone: '08031110001',
    pickup_address: 'Ikeja City Mall', pickup_location: { lat: 6.6142, lng: 3.3581 },
    dropoff_address: '12 Admiralty Way, Lekki', dropoff_location: { lat: 6.4474, lng: 3.4723 },
  })).body;
  ids.route = (await api.post('/routes').set(as).send({ driver_id: ids.driver })).body.id;
  await api.put(`/routes/${ids.route}/stops`).set(as).send({ stop_ids: [ids.order.pickup_stop_id, ids.order.dropoff_stop_id] }).expect(200);
});

after(async () => {
  server.close();
  termii.close();
  await ctx.teardown();
});

const as = (t) => ({ Authorization: `Bearer ${t}` });
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

function openSocket(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}?token=${token}`);
    const events = [];
    ws.on('message', (m) => events.push(JSON.parse(m)));
    ws.on('open', () => resolve({ ws, events }));
    ws.on('error', reject);
  });
}

test('the WebSocket only accepts staff tokens', async () => {
  await assert.rejects(openSocket('nonsense'));
  await assert.rejects(openSocket(driverToken));
  const { ws, events } = await openSocket(staff);
  await wait(100);
  assert.equal(events[0].type, 'hello');
  ws.close();
});

test('driver positions are stored once, keep their time, and reach the dashboard with ETAs', async () => {
  const { ws, events } = await openSocket(staff);
  const at = minutesAgo(1);
  const first = await api.post('/driver/locations').set(as(driverToken)).send({ points: [
    { lat: 6.62, lng: 3.36, accuracy_m: 10, app_visible: true, recorded_at: at },
    { lat: 1, lng: 1, recorded_at: new Date(Date.now() + 3600_000).toISOString() }, // future: ignored
    { lat: 1, lng: 1, recorded_at: minutesAgo(60 * 72) }, // three days old: ignored
  ] });
  assert.equal(first.body.accepted, 1);
  const again = await api.post('/driver/locations').set(as(driverToken)).send({ points: [{ lat: 6.62, lng: 3.36, recorded_at: at }] });
  assert.equal(again.body.accepted, 0);
  assert.equal((await api.post('/driver/locations').set(as(staff)).send({ points: [{ lat: 1, lng: 1, recorded_at: at }] })).status, 403);

  await wait(300);
  const loc = events.find((e) => e.type === 'location');
  assert.equal(loc.driver_id, ids.driver);
  assert.equal(loc.route_id, ids.route);
  assert.equal(loc.eta.length, 2, 'an ETA for both remaining stops');
  assert.ok(new Date(loc.eta[1].eta) > new Date(loc.eta[0].eta), 'the dropoff comes after the pickup');
  const { rows } = await ctx.pool.query('SELECT route_id, recorded_at FROM driver_locations');
  assert.equal(rows.length, 1);
  assert.equal(new Date(rows[0].recorded_at).toISOString(), at);
  ws.close();
});

test('the live view has the driver, their stops and ETAs from the position', async () => {
  const live = await api.get('/live').set(as(staff));
  assert.equal(live.status, 200);
  const r = live.body.routes[0];
  assert.equal(r.driver, 'Musa Abdullahi');
  assert.equal(r.eta_from, 'driver');
  assert.ok(r.location && r.location.age_s < 120);
  assert.ok(r.stops.every((s) => s.eta));
  assert.equal((await api.get('/live').set(as(driverToken))).status, 403);
});

test('stop updates are pushed, and the customer is texted once when the driver sets off', async () => {
  const { ws, events } = await openSocket(staff);
  await api.post(`/driver/stops/${ids.order.pickup_stop_id}/status`).set(as(driverToken)).send({ action: 'complete' }).expect(200);
  await api.post(`/driver/stops/${ids.order.dropoff_stop_id}/status`).set(as(driverToken)).send({ action: 'start' }).expect(200);
  await api.post(`/driver/stops/${ids.order.dropoff_stop_id}/status`).set(as(driverToken)).send({ action: 'start' }).expect(200); // replay
  await wait(400);
  assert.deepEqual(events.filter((e) => e.type === 'stop').map((e) => e.action), ['complete', 'start']);
  const { rows } = await ctx.pool.query('SELECT reason, status, provider, to_phone, body FROM sms_messages');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'en_route');
  assert.equal(rows[0].status, 'logged');
  assert.equal(rows[0].to_phone, '+2348031110001');
  assert.match(rows[0].body, /^Hi Chioma, your delivery is on the way\. Track it here: http.+\/track\/[0-9a-f]{32}$/);
  ws.close();
});

test('the public tracking page shows what the customer needs and nothing more', async () => {
  const detail = await api.get(`/orders/${ids.order.id}`).set(as(staff));
  const token = detail.body.tracking_url.split('/').pop();
  assert.equal((await request(ctx.app).get('/public/track/0123')).status, 404);
  assert.equal((await request(ctx.app).get(`/public/track/${'a'.repeat(32)}`)).status, 404);

  // A fresh position, so the driver shows while on the way.
  await api.post('/driver/locations').set(as(driverToken)).send({ points: [{ lat: 6.5, lng: 3.42, recorded_at: new Date().toISOString() }] });
  const res = await request(ctx.app).get(`/public/track/${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'en_route');
  assert.equal(res.body.customer_first_name, 'Chioma');
  assert.equal(res.body.driver.first_name, 'Musa');
  assert.ok(res.body.driver.location);
  assert.ok(res.body.eta.minutes >= 0);
  const text = JSON.stringify(res.body);
  for (const secret of ['+234', 'Okafor', 'Abdullahi', 'Ikeja City Mall']) assert.ok(!text.includes(secret), `does not reveal ${secret}`);
});

test('delivery texts the customer once more; a dispatcher can resend the link', async () => {
  await api.post(`/driver/stops/${ids.order.dropoff_stop_id}/status`).set(as(driverToken)).send({ action: 'complete' }).expect(200);
  await wait(300);
  const manual = await api.post(`/orders/${ids.order.id}/send-tracking`).set(as(staff));
  assert.equal(manual.status, 201);
  await api.post(`/orders/${ids.order.id}/send-tracking`).set(as(staff)).expect(201);
  const reasons = (await ctx.pool.query('SELECT reason FROM sms_messages ORDER BY id')).rows.map((r) => r.reason);
  assert.deepEqual(reasons, ['en_route', 'delivered', 'manual', 'manual']);
  const outbox = await api.get('/sms').set(as(staff));
  assert.equal(outbox.body.provider, 'log');
  assert.equal(outbox.body.messages.length, 4);
});

test('Termii: the key is write-only and messages go out in Termii\'s format', async () => {
  const key = 'TLabcdefghijklmnopqrstuvwxyz0123';
  const saved = await api.put('/settings').set(as(admin)).send({ sms: {
    provider: 'termii', base_url: 'https://example.invalid', api_key: key, sender_id: 'Swift', channel: 'dnd', company_name: 'Swift Couriers',
  } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.sms.api_key_hint, 'TLab…0123');
  assert.ok(!JSON.stringify(saved.body).includes(key));
  const { rows } = await ctx.pool.query("SELECT value FROM app_settings WHERE key = 'termii_api_key'");
  assert.match(rows[0].value, /^enc:v1:/);
  assert.equal((await api.put('/settings').set(as(staff)).send({ sms: { provider: 'log' } })).status, 403);
  assert.equal((await api.put('/settings').set(as(admin)).send({ sms: { base_url: 'http://plain' } })).status, 400);

  // Point Termii at the stand-in (http is fine for a test server).
  await ctx.pool.query("UPDATE app_settings SET value = $1 WHERE key = 'termii_base_url'", [`http://127.0.0.1:${termii.address().port}`]);
  termiiCalls = [];
  const sent = await api.post(`/orders/${ids.order.id}/send-tracking`).set(as(staff));
  assert.equal(sent.body.status, 'sent');
  assert.equal(sent.body.provider_message_id, '123');
  assert.equal(termiiCalls[0].path, '/api/sms/send');
  const b = termiiCalls[0].body;
  assert.equal(b.to, '2348031110001', 'international format without the plus');
  assert.equal(b.from, 'Swift');
  assert.equal(b.channel, 'dnd');
  assert.equal(b.type, 'plain');
  assert.equal(b.api_key, key);
  assert.match(b.sms, /your Swift Couriers delivery/);
});

test('Brevo: the key is write-only and messages go out in Brevo\'s format', async () => {
  process.env.BREVO_API_URL = `http://127.0.0.1:${termii.address().port}`;
  const key = 'xkeysib-abcdefghijklmnopqrstuvwxyz0123456789';
  const saved = await api.put('/settings').set(as(admin)).send({ sms: { provider: 'brevo', brevo_api_key: key, brevo_sender: 'SwiftCour' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.sms.provider, 'brevo');
  assert.equal(saved.body.sms.brevo.api_key_hint, 'xkeysi…6789');
  assert.ok(!JSON.stringify(saved.body).includes(key));
  const { rows } = await ctx.pool.query("SELECT value FROM app_settings WHERE key = 'brevo_api_key'");
  assert.match(rows[0].value, /^enc:v1:/);
  assert.equal((await api.put('/settings').set(as(admin)).send({ sms: { brevo_sender: 'Has space' } })).status, 400);

  termiiCalls = [];
  const sent = await api.post(`/orders/${ids.order.id}/send-tracking`).set(as(staff));
  assert.equal(sent.body.status, 'sent');
  assert.equal(sent.body.provider, 'brevo');
  assert.equal(sent.body.provider_message_id, '1511882900176220');
  const call = termiiCalls[0];
  assert.equal(call.path, '/v3/transactionalSMS/send');
  assert.equal(call.headers['api-key'], key);
  assert.deepEqual(Object.keys(call.body).sort(), ['content', 'recipient', 'sender', 'tag', 'type']);
  assert.equal(call.body.recipient, '2348031110001');
  assert.equal(call.body.sender, 'SwiftCour');
  assert.equal(call.body.type, 'transactional');
  assert.match(call.body.content, /track/);
  delete process.env.BREVO_API_URL;
});

test('tracking quality counts gaps and the ones while the app was hidden', async () => {
  await ctx.pool.query('DELETE FROM driver_locations');
  const base = Date.now() - 20 * 60_000;
  const pts = [0, 30, 60, 90, 600, 630, 660].map((s, i) => ({
    lat: 6.5, lng: 3.4, app_visible: i !== 4, recorded_at: new Date(base + s * 1000).toISOString(),
  }));
  await api.post('/driver/locations').set(as(driverToken)).send({ points: pts }).expect(200);
  const q = await api.get('/live/tracking-quality').set(as(staff));
  const d = q.body.drivers[0];
  assert.equal(d.points, 7);
  assert.equal(d.gaps_over_90s, 1);
  assert.equal(d.longest_gap_s, 510);
  assert.equal(d.gap_minutes_while_hidden, 9);
  assert.ok(d.coverage < 0.5);
});
