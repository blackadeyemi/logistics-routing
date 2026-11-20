// Route optimization in api-node: the distance matrix, the run and its
// comparison with the manual plan, accepting (which moves stops between
// drivers), stale plans, and refusing a plan that breaks a rule. A
// stand-in for service-python's solver answers with a scripted plan.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const bcrypt = require('bcrypt');

let ctx;
let api;
let staff;
let fake;
let mode = 'last_vehicle';
let lastSolve;
const ids = {};

before(async () => {
  // Stand-in solver: every order on the last vehicle, pickup then dropoff.
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastSolve = JSON.parse(body);
      const { vehicles, orders, distances_m: d } = lastSolve;
      let stops = orders.flatMap((o) => [o.pickup, o.dropoff]);
      if (mode === 'dropoff_first') stops = orders.flatMap((o) => [o.dropoff, o.pickup]);
      let dist = 0;
      for (let i = 1; i < stops.length; i += 1) dist += d[stops[i - 1]][stops[i]];
      // "overload" puts everything on the first vehicle (the 20 kg bike).
      const vehicle = mode === 'overload' ? vehicles[0] : vehicles.at(-1);
      const peak = Math.max(...orders.map((o) => o.weight_kg));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        status: 'ok', solve_ms: 12, unassigned: [], total_distance_m: dist,
        routes: [{ driver_id: vehicle.driver_id, stops, arrival_min: stops.map((_, i) => 480 + i * 10), distance_m: dist, peak_load_kg: peak }],
      }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.PYTHON_SERVICE_URL = `http://127.0.0.1:${fake.address().port}`;
  const { setup } = require('../test-support/setup');
  ctx = await setup();
  api = request(ctx.app);
  const hash = await bcrypt.hash('password123', 10);
  await ctx.pool.query("INSERT INTO users (email, password_hash, full_name, role) VALUES ('d@example.com', $1, 'Dee', 'dispatcher')", [hash]);
  staff = (await api.post('/auth/login').send({ email: 'd@example.com', password: 'password123' })).body.token;

  const as = { Authorization: `Bearer ${staff}` };
  const bike = (await api.post('/vehicles').set(as).send({ type: 'bike', plate_number: 'LAG-1', capacity_kg: 20 })).body;
  const van = (await api.post('/vehicles').set(as).send({ type: 'van', plate_number: 'LAG-2', capacity_kg: 800 })).body;
  ids.musa = (await api.post('/drivers').set(as).send({ name: 'Musa', phone: '08020000001', vehicle_id: bike.id })).body.id;
  ids.peter = (await api.post('/drivers').set(as).send({ name: 'Peter', phone: '08020000004', vehicle_id: van.id })).body.id;
  const order = async (name, phone, p, d) => (await api.post('/orders').set(as).send({
    customer_name: name, customer_phone: phone,
    pickup_address: p[0], pickup_location: { lat: p[1], lng: p[2] },
    dropoff_address: d[0], dropoff_location: { lat: d[1], lng: d[2] },
  })).body;
  ids.o1 = await order('Chioma', '08031110001', ['Ikeja City Mall', 6.6142, 3.3581], ['Admiralty Way, Lekki', 6.4474, 3.4723]);
  ids.o2 = await order('Tunde', '08031110002', ['Allen Avenue, Ikeja', 6.6018, 3.3515], ['Adeola Odeku, VI', 6.4281, 3.4219]);
  // Manual plan: Musa has order 1; order 2 is unassigned.
  ids.route = (await api.post('/routes').set(as).send({ driver_id: ids.musa })).body.id;
  await api.put(`/routes/${ids.route}/stops`).set(as).send({ stop_ids: [ids.o1.pickup_stop_id, ids.o1.dropoff_stop_id] }).expect(200);
});

after(async () => {
  await ctx.teardown();
  fake.close();
});

const as = () => ({ Authorization: `Bearer ${staff}` });

function haversineM(a, b) {
  const r = (x) => (x * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

test('the straight-line matrix matches an independent calculation', async () => {
  const { distanceMatrix } = require('../src/distance');
  const a = { lat: 6.6142, lng: 3.3581 };
  const b = { lat: 6.4474, lng: 3.4723 };
  const m = await distanceMatrix([a, b]);
  assert.equal(m.provider, 'straight_line');
  assert.equal(m.distances_m[0][0], 0);
  assert.equal(m.distances_m[0][1], m.distances_m[1][0]);
  assert.ok(Math.abs(m.distances_m[0][1] - haversineM(a, b)) / haversineM(a, b) < 0.005, 'within 0.5% of haversine');
  assert.ok(m.durations_s[0][1] > 0);
});

test('a run proposes a plan, compares it with the manual one, and changes nothing', async () => {
  const run = await api.post('/optimizations').set(as()).send({});
  assert.equal(run.status, 201);
  assert.equal(run.body.status, 'proposed');
  assert.equal(run.body.manual.summary.manual.routes, 1);
  assert.equal(run.body.manual.summary.manual.orders, 1);
  assert.equal(run.body.manual.summary.unplanned_orders_added, 1);
  assert.equal(run.body.proposed[0].driver, 'Peter');
  assert.equal(lastSolve.orders.length, 2);
  assert.deepEqual(lastSolve.vehicles.map((v) => v.capacity_kg), [20, 800]);
  const route = await api.get(`/routes/${ids.route}`).set(as());
  assert.deepEqual(route.body.stops.map((s) => s.id), [ids.o1.pickup_stop_id, ids.o1.dropoff_stop_id]);
  ids.run = run.body.id;
});

test('accepting moves stops between drivers and removes emptied routes', async () => {
  const accepted = await api.post(`/optimizations/${ids.run}/accept`).set(as());
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.status, 'accepted');
  const routes = (await api.get('/routes').set(as())).body;
  assert.deepEqual(routes.map((r) => [r.driver.name, r.stop_count]), [['Peter', 4]]);
  const o1 = await api.get(`/orders/${ids.o1.id}`).set(as());
  assert.equal(o1.body.status, 'assigned');
  assert.deepEqual(o1.body.events.map((e) => e.event_type).slice(-2), ['unassigned', 'assigned']);
  assert.equal((await api.post(`/optimizations/${ids.run}/accept`).set(as())).status, 409);
});

test('a plan made before the day changed is refused as stale', async () => {
  const run = (await api.post('/optimizations').set(as()).send({})).body;
  await api.post('/orders').set(as()).send({
    customer_name: 'Late', customer_phone: '08031110003', pickup_address: 'Yaba', pickup_location: { lat: 6.5095, lng: 3.3711 },
    dropoff_address: 'Surulere', dropoff_location: { lat: 6.5006, lng: 3.3581 },
  });
  const res = await api.post(`/optimizations/${run.id}/accept`).set(as());
  assert.equal(res.status, 409);
  assert.equal(res.body.details.code, 'stale');
  assert.equal((await api.get(`/optimizations/${run.id}`).set(as())).body.status, 'stale');
});

test('a kept route and its orders stay out of the run', async () => {
  const run = (await api.post('/optimizations').set(as()).send({ keep_driver_ids: [ids.peter] })).body;
  assert.deepEqual(lastSolve.vehicles.map((v) => v.driver_id), [ids.musa]);
  assert.ok(!lastSolve.orders.some((o) => [ids.o1.id, ids.o2.id].includes(o.order_id)), 'Peter\'s orders are not re-planned');
  assert.equal(run.manual.summary.manual.routes, 0);
  await api.post(`/optimizations/${run.id}/discard`).set(as()).expect(200);
});

test('orders carry weight and a delivery window for the optimizer', async () => {
  const bad = await api.patch(`/orders/${ids.o2.id}`).set(as()).send({ dropoff_after: '17:00', dropoff_before: '09:00' });
  assert.equal(bad.status, 400);
  const badTime = await api.patch(`/orders/${ids.o2.id}`).set(as()).send({ dropoff_after: '4pm' });
  assert.equal(badTime.status, 400);
  const ok = await api.patch(`/orders/${ids.o2.id}`).set(as()).send({ weight_kg: 30, dropoff_after: '16:00', dropoff_before: '' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.weight_kg, 30);
  assert.equal(ok.body.dropoff_after, '16:00');
  assert.equal(ok.body.dropoff_before, null);
  await api.post('/optimizations').set(as()).send({});
  const sent = lastSolve.orders.find((o) => o.order_id === ids.o2.id);
  assert.equal(sent.weight_kg, 30);
  assert.equal(sent.dropoff_after_min, 16 * 60);
});

test('a solver plan that breaks a rule never reaches the dispatcher', async () => {
  await ctx.pool.query("UPDATE optimization_runs SET status = 'discarded' WHERE status = 'proposed'");
  for (const m of ['dropoff_first', 'overload']) {
    mode = m;
    const res = await api.post('/optimizations').set(as()).send({});
    assert.equal(res.status, 500, m);
  }
  mode = 'last_vehicle';
  const { rows } = await ctx.pool.query("SELECT count(*) AS n FROM optimization_runs WHERE status = 'proposed'");
  assert.equal(rows[0].n, 0);
});
