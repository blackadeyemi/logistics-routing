const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcrypt');
const { setup } = require('../test-support/setup');

let ctx;
let api;
let staff;
let admin;

const auth = (token) => ({ Authorization: `Bearer ${token}` });

before(async () => {
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
  staff = (await api.post('/auth/login').send({ email: 'Dispatcher@Example.com', password: 'password123' })).body.token;
});

after(async () => {
  await ctx.teardown();
});

async function makeOrder(name) {
  const res = await api.post('/orders').set(auth(staff)).send({
    customer_name: name,
    customer_phone: '0803 123 4567',
    pickup_address: 'Ikeja City Mall',
    pickup_location: { lat: 6.6142, lng: 3.3581 },
    dropoff_address: '12 Admiralty Way, Lekki',
    dropoff_location: { lat: 6.4474, lng: 3.4723 },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function makeDriver(phone, pin = '1234') {
  const res = await api.post('/drivers').set(auth(staff)).send({ name: `Driver ${phone}`, phone, pin });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const login = await api.post('/auth/driver-login').send({ phone, pin });
  assert.equal(login.status, 200);
  return { driver: res.body, token: login.body.token };
}

test('auth rejects bad credentials and wrong roles', async () => {
  const bad = await api.post('/auth/login').send({ email: 'admin@example.com', password: 'nope' });
  assert.equal(bad.status, 401);
  assert.equal((await api.get('/orders')).status, 401);
  assert.equal((await api.get('/users').set(auth(staff))).status, 403);
  assert.equal((await api.get('/users').set(auth(admin))).status, 200);
  const me = await api.get('/auth/me').set(auth(staff));
  assert.equal(me.body.role, 'dispatcher');
});

test('validation and phone normalisation', async () => {
  const bad = await api.post('/orders').set(auth(staff)).send({ customer_name: 'X', customer_phone: '12345' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.details.some((d) => d.path === 'customer_phone'));

  const order = await makeOrder('Phone Check');
  assert.equal(order.customer_phone, '+2348031234567');
  assert.deepEqual(order.pickup_location, { lat: 6.6142, lng: 3.3581 });
  assert.ok(order.pickup_stop_id && order.dropoff_stop_id);
});

test('vehicles and drivers CRUD', async () => {
  const v = await api.post('/vehicles').set(auth(staff)).send({ type: 'bike', plate_number: 'lag-1-aa', capacity_kg: 20 });
  assert.equal(v.status, 201);
  assert.equal(v.body.plate_number, 'LAG-1-AA');
  const dup = await api.post('/vehicles').set(auth(staff)).send({ type: 'van', plate_number: 'LAG-1-AA' });
  assert.equal(dup.status, 409);

  const d = await api.post('/drivers').set(auth(staff)).send({ name: 'Musa', phone: '+234 802 000 0099', vehicle_id: v.body.id });
  assert.equal(d.status, 201);
  assert.equal(d.body.has_pin, false);
  assert.equal(d.body.vehicle.plate_number, 'LAG-1-AA');

  const patched = await api.patch(`/drivers/${d.body.id}`).set(auth(staff)).send({ vehicle_id: null });
  assert.equal(patched.body.vehicle, null);
  assert.equal((await api.delete(`/drivers/${d.body.id}`).set(auth(staff))).status, 204);
});

test('manual assignment enforces route rules', async () => {
  const { driver } = await makeDriver('08020000011');
  const a = await makeOrder('A');
  const b = await makeOrder('B');
  const route = (await api.post('/routes').set(auth(staff)).send({ driver_id: driver.id })).body;

  const put = (ids) => api.put(`/routes/${route.id}/stops`).set(auth(staff)).send({ stop_ids: ids });

  assert.equal((await put([a.dropoff_stop_id, a.pickup_stop_id])).status, 409, 'dropoff before pickup');
  assert.equal((await put([a.pickup_stop_id])).status, 409, 'pickup without dropoff');
  assert.equal((await put([999999])).status, 400, 'unknown stop');

  const ok = await put([a.pickup_stop_id, b.pickup_stop_id, a.dropoff_stop_id, b.dropoff_stop_id]);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.stops.map((s) => s.sequence_number), [1, 2, 3, 4]);
  assert.equal((await api.get(`/orders/${a.id}`).set(auth(staff))).body.status, 'assigned');

  // A second route cannot take stops that are already planned.
  const { driver: other } = await makeDriver('08020000012');
  const route2 = (await api.post('/routes').set(auth(staff)).send({ driver_id: other.id })).body;
  const steal = await api.put(`/routes/${route2.id}/stops`).set(auth(staff))
    .send({ stop_ids: [a.pickup_stop_id, a.dropoff_stop_id] });
  assert.equal(steal.status, 409);

  // Same driver, same day is rejected.
  assert.equal((await api.post('/routes').set(auth(staff)).send({ driver_id: driver.id })).status, 409);

  // Removing B sends it back to pending.
  const fewer = await put([a.pickup_stop_id, a.dropoff_stop_id]);
  assert.equal(fewer.body.stops.length, 2);
  const bAfter = await api.get(`/orders/${b.id}`).set(auth(staff));
  assert.equal(bAfter.body.status, 'pending');
  assert.deepEqual(bAfter.body.events.map((e) => e.event_type), ['created', 'assigned', 'unassigned']);

  // Cancelling A empties the route.
  const cancel = await api.post(`/orders/${a.id}/cancel`).set(auth(staff));
  assert.equal(cancel.body.status, 'cancelled');
  assert.equal((await api.get(`/routes/${route.id}`).set(auth(staff))).body.stops.length, 0);
  assert.equal((await api.delete(`/routes/${route.id}`).set(auth(staff))).status, 204);
});

test('driver completes a route with offline retries', async () => {
  const { driver, token } = await makeDriver('08020000021');
  const order = await makeOrder('Delivery');
  const route = (await api.post('/routes').set(auth(staff)).send({ driver_id: driver.id })).body;
  await api.put(`/routes/${route.id}/stops`).set(auth(staff))
    .send({ stop_ids: [order.pickup_stop_id, order.dropoff_stop_id] });

  const today = await api.get('/driver/route').set(auth(token));
  assert.equal(today.body.route.id, route.id);
  assert.equal(today.body.route.stops[0].stop_type, 'pickup');

  // Another driver cannot touch this route.
  const { token: stranger } = await makeDriver('08020000022');
  const denied = await api.post(`/driver/stops/${order.pickup_stop_id}/status`).set(auth(stranger)).send({ action: 'arrive' });
  assert.equal(denied.status, 404);
  assert.equal((await api.get('/orders').set(auth(token))).status, 403);

  const act = (stopId, body) => api.post(`/driver/stops/${stopId}/status`).set(auth(token)).send(body);

  assert.equal((await act(order.dropoff_stop_id, { action: 'complete' })).status, 409, 'dropoff before pickup');

  // The order was assigned an hour ago. The driver tapped 10 minutes ago
  // while offline, the update is sent now, then retried.
  await ctx.pool.query(
    "UPDATE order_events SET occurred_at = now() - interval '1 hour' WHERE order_id = $1",
    [order.id],
  );
  const tapped = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const queued = { action: 'complete', occurred_at: tapped, client_event_id: 'evt-pickup-0001' };
  const first = await act(order.pickup_stop_id, queued);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.replayed, false);
  assert.equal(first.body.route.status, 'in_progress');
  const retry = await act(order.pickup_stop_id, queued);
  assert.equal(retry.body.replayed, true);

  assert.equal((await act(order.dropoff_stop_id, { action: 'start' })).status, 200);
  assert.equal((await act(order.dropoff_stop_id, { action: 'arrive' })).status, 200);
  const done = await act(order.dropoff_stop_id, { action: 'complete', client_event_id: 'evt-drop-0001' });
  assert.equal(done.body.route.status, 'completed');

  const detail = await api.get(`/orders/${order.id}`).set(auth(staff));
  assert.equal(detail.body.status, 'delivered');
  const types = detail.body.events.map((e) => e.event_type);
  assert.deepEqual(types, ['created', 'assigned', 'picked_up', 'en_route', 'arrived', 'delivered']);
  const pickedUp = detail.body.events.find((e) => e.event_type === 'picked_up');
  assert.equal(new Date(pickedUp.occurred_at).toISOString(), tapped);

  const future = await act(order.dropoff_stop_id, { action: 'skip', occurred_at: new Date(Date.now() + 3600e3).toISOString() });
  assert.equal(future.status, 400);
});

test('skipping a pickup sends the order back to pending', async () => {
  const { driver, token } = await makeDriver('08020000031');
  const order = await makeOrder('Skipped');
  const route = (await api.post('/routes').set(auth(staff)).send({ driver_id: driver.id })).body;
  await api.put(`/routes/${route.id}/stops`).set(auth(staff))
    .send({ stop_ids: [order.pickup_stop_id, order.dropoff_stop_id] });

  const res = await api.post(`/driver/stops/${order.pickup_stop_id}/status`).set(auth(token)).send({ action: 'skip' });
  assert.equal(res.status, 200);
  assert.equal(res.body.route.stops.length, 0);
  const after = await api.get(`/orders/${order.id}`).set(auth(staff));
  assert.equal(after.body.status, 'pending');
  assert.equal(after.body.route_id, null);
});

test('a driver time before assignment is clamped to the assignment', async () => {
  const { driver, token } = await makeDriver('08020000041');
  const order = await makeOrder('Bad clock');
  const route = (await api.post('/routes').set(auth(staff)).send({ driver_id: driver.id })).body;
  await api.put(`/routes/${route.id}/stops`).set(auth(staff))
    .send({ stop_ids: [order.pickup_stop_id, order.dropoff_stop_id] });

  const early = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  await api.post(`/driver/stops/${order.pickup_stop_id}/status`).set(auth(token))
    .send({ action: 'complete', occurred_at: early });

  const { body } = await api.get(`/orders/${order.id}`).set(auth(staff));
  assert.deepEqual(body.events.map((e) => e.event_type), ['created', 'assigned', 'picked_up']);
  const assigned = body.events.find((e) => e.event_type === 'assigned');
  const picked = body.events.find((e) => e.event_type === 'picked_up');
  assert.equal(picked.occurred_at, assigned.occurred_at);
});

test('dashboard stats count today\'s work', async () => {
  const res = await api.get('/stats/today').set(auth(staff));
  assert.equal(res.status, 200);
  for (const key of ['pending', 'assigned', 'in_transit', 'delivered_today', 'failed_today', 'routes_today', 'drivers_free']) {
    assert.equal(typeof res.body[key], 'number', key);
  }
  assert.ok(res.body.delivered_today >= 1, 'the delivery test above delivered one order today');
  assert.match(res.body.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('admins manage the Google Maps settings, staff can read them', async () => {
  const empty = await api.get('/settings').set('Authorization', `Bearer ${staff}`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.google_maps, { api_key: '', map_id: '', updated_at: null, updated_by: null });

  const key = 'AIzaSyTestKey_0123456789-abcdefghijklm';
  const denied = await api.put('/settings').set('Authorization', `Bearer ${staff}`).send({ google_maps: { api_key: key } });
  assert.equal(denied.status, 403);

  const bad = await api.put('/settings').set('Authorization', `Bearer ${admin}`).send({ google_maps: { api_key: 'not a key!' } });
  assert.equal(bad.status, 400);

  const saved = await api.put('/settings').set('Authorization', `Bearer ${admin}`).send({ google_maps: { api_key: ` ${key} `, map_id: 'abc123' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.google_maps.api_key, key);
  assert.equal(saved.body.google_maps.map_id, 'abc123');
  assert.ok(saved.body.google_maps.updated_by);

  const read = await api.get('/settings').set('Authorization', `Bearer ${staff}`);
  assert.equal(read.body.google_maps.api_key, key);

  const cleared = await api.put('/settings').set('Authorization', `Bearer ${admin}`).send({ google_maps: { map_id: '' } });
  assert.equal(cleared.body.google_maps.map_id, '');
  assert.equal(cleared.body.google_maps.api_key, key);

  const anon = await api.get('/settings');
  assert.equal(anon.status, 401);
});
