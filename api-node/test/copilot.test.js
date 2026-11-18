// Copilot safety rules in api-node: proposals change nothing until a
// dispatcher confirms, confirmation applies through the normal API, users
// only see their own conversations, and the chat stream stores the turn.
// A stand-in for service-python replays a scripted turn; no Anthropic calls.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');
const bcrypt = require('bcrypt');

let ctx;
let api;
let admin;
let staff;
let staff2;
let fake;
let lastChat;
let order;
let driverId;

before(async () => {
  // Stand-in /ai/chat: streams a little text, one proposal made through the
  // real POST /ai/actions with the user's token, then the done event.
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      lastChat = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      send({ type: 'text', delta: 'Proposing a route.' });
      const proposal = await request(ctx.app).post('/ai/actions').set('Authorization', `Bearer ${lastChat.user_token}`).send({
        conversation_id: lastChat.conversation_id, prompt: lastChat.prompt, tool: 'assign_stops',
        arguments: { driver_id: driverId, stop_ids: [order.pickup_stop_id, order.dropoff_stop_id] },
      });
      send({ type: 'proposal', action: proposal.body });
      send({
        type: 'done',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Proposing a route.' }] }],
        display: [{ type: 'assistant', text: 'Proposing a route.' }, { type: 'proposal', action_id: proposal.body.id }],
        usage: { input_tokens: 10, output_tokens: 20, cache_read_tokens: 5, model: 'claude-sonnet-5-5' },
      });
      res.end();
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  delete process.env.ANTHROPIC_API_KEY;
  process.env.PYTHON_SERVICE_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');

  const { setup } = require('../test-support/setup');
  ctx = await setup();
  api = request(ctx.app);
  const hash = await bcrypt.hash('password123', 10);
  await ctx.pool.query(
    `INSERT INTO users (email, password_hash, full_name, role) VALUES
     ('admin@example.com', $1, 'Admin', 'admin'), ('d1@example.com', $1, 'Dee One', 'dispatcher'), ('d2@example.com', $1, 'Dee Two', 'dispatcher')`,
    [hash],
  );
  const login = async (email) => (await api.post('/auth/login').send({ email, password: 'password123' })).body.token;
  admin = await login('admin@example.com');
  staff = await login('d1@example.com');
  staff2 = await login('d2@example.com');
  await api.put('/settings').set(as(admin)).send({ ai: { api_key: 'sk-ant-api03-copilotKEY_abcdefghijklmnopqrstuvwxyz', model: 'claude-sonnet-5-5' } });
  order = (await api.post('/orders').set(as(staff)).send({
    customer_name: 'Kemi Lawal', customer_phone: '08124443322', pickup_address: '7 Isaac John Street, Ikeja', dropoff_address: '25 Ademola Adetokunbo, Victoria Island',
  })).body;
  driverId = (await api.post('/drivers').set(as(staff)).send({ name: 'Peter Etim', phone: '08020000004' })).body.id;
});

after(async () => {
  await ctx.teardown();
  fake.close();
});

const as = (t) => ({ Authorization: `Bearer ${t}` });

async function chat(token, body) {
  const res = await api.post('/ai/chat').set(as(token)).send(body).buffer(true).parse((r, cb) => {
    let t = '';
    r.on('data', (c) => { t += c; });
    r.on('end', () => cb(null, t));
  });
  const events = res.body.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  return { status: res.status, events };
}

test('a chat turn streams, stores the conversation and proposes without writing', async () => {
  const { status, events } = await chat(staff, { message: 'Give Peter the Kemi order' });
  assert.equal(status, 200);
  assert.deepEqual(events.map((e) => e.type), ['start', 'text', 'proposal', 'done']);
  // The model messages stay on the server.
  assert.equal(events.at(-1).messages, undefined);
  assert.equal(lastChat.model, 'claude-sonnet-5-5');
  assert.equal(lastChat.messages.at(-1).content.at(-1).text, 'Give Peter the Kemi order');

  const proposal = events[2].action;
  assert.equal(proposal.status, 'proposed');
  assert.match(proposal.summary, /Peter Etim's route/);
  const { rows: routes } = await ctx.pool.query('SELECT count(*) AS n FROM routes');
  assert.equal(routes[0].n, 0, 'nothing is written by a proposal');

  const conv = await api.get(`/ai/conversations/${events[0].conversation_id}`).set(as(staff));
  assert.equal(conv.status, 200);
  assert.deepEqual(conv.body.display.map((d) => d.type), ['user', 'assistant', 'proposal']);
  const { rows: usage } = await ctx.pool.query("SELECT feature, ok FROM ai_usage WHERE feature = 'copilot'");
  assert.deepEqual(usage, [{ feature: 'copilot', ok: true }]);
});

test('other dispatchers cannot see or decide someone else\'s proposals', async () => {
  const { rows } = await ctx.pool.query('SELECT id, conversation_id FROM agent_actions ORDER BY id DESC LIMIT 1');
  assert.equal((await api.get(`/ai/conversations/${rows[0].conversation_id}`).set(as(staff2))).status, 404);
  assert.equal((await api.post(`/ai/actions/${rows[0].id}/confirm`).set(as(staff2))).status, 404);
  assert.equal((await api.post('/ai/actions').set(as(staff2)).send({
    conversation_id: rows[0].conversation_id, prompt: 'x', tool: 'cancel_order', arguments: { order_id: order.id },
  })).status, 404);
});

test('invalid proposals are refused with a reason the agent can act on', async () => {
  const { rows } = await ctx.pool.query('SELECT conversation_id FROM agent_actions LIMIT 1');
  const cid = rows[0].conversation_id;
  const half = await api.post('/ai/actions').set(as(staff)).send({
    conversation_id: cid, prompt: 'x', tool: 'assign_stops', arguments: { driver_id: driverId, stop_ids: [order.dropoff_stop_id] },
  });
  assert.equal(half.status, 409);
  assert.match(half.body.error, /only its dropoff/);
  const reversed = await api.post('/ai/actions').set(as(staff)).send({
    conversation_id: cid, prompt: 'x', tool: 'assign_stops', arguments: { driver_id: driverId, stop_ids: [order.dropoff_stop_id, order.pickup_stop_id] },
  });
  assert.match(reversed.body.error, /dropoff comes before its pickup/);
  const badPhone = await api.post('/ai/actions').set(as(staff)).send({
    conversation_id: cid, prompt: 'x', tool: 'create_order',
    arguments: { customer_name: 'A', customer_phone: '12345', pickup_address: 'a', dropoff_address: 'b' },
  });
  assert.equal(badPhone.status, 400);
  assert.match(badPhone.body.error, /customer_phone/);
  const unknown = await api.post('/ai/actions').set(as(staff)).send({ conversation_id: cid, prompt: 'x', tool: 'delete_everything', arguments: {} });
  assert.equal(unknown.status, 400);
});

test('confirming applies the change once; the next turn hears about it', async () => {
  const { rows } = await ctx.pool.query("SELECT id, conversation_id FROM agent_actions WHERE status = 'proposed' ORDER BY id LIMIT 1");
  const confirmed = await api.post(`/ai/actions/${rows[0].id}/confirm`).set(as(staff));
  assert.equal(confirmed.body.status, 'confirmed');
  assert.match(confirmed.body.result.message, /now has 2 stops/);
  const again = await api.post(`/ai/actions/${rows[0].id}/confirm`).set(as(staff));
  assert.equal(again.status, 409);

  const route = await api.get(`/routes/${confirmed.body.result.route_id}`).set(as(staff));
  assert.equal(route.body.driver.name, 'Peter Etim');
  assert.deepEqual(route.body.stops.map((s) => s.id), [order.pickup_stop_id, order.dropoff_stop_id]);

  await chat(staff, { conversation_id: rows[0].conversation_id, message: 'Done?' });
  const note = lastChat.messages.at(-1).content[0].text;
  assert.match(note, /\[Status of your proposals\]/);
  assert.match(note, new RegExp(`Action #${rows[0].id} \\(assign_stops\\) was confirmed and applied`));
});

test('rejecting leaves everything as it was', async () => {
  const { rows } = await ctx.pool.query("SELECT id FROM agent_actions WHERE status = 'proposed' ORDER BY id DESC LIMIT 1");
  const rejected = await api.post(`/ai/actions/${rows[0].id}/reject`).set(as(staff));
  assert.equal(rejected.body.status, 'rejected');
  assert.equal((await api.post(`/ai/actions/${rows[0].id}/confirm`).set(as(staff))).status, 409);
});

test('a dispatcher can record a stop update for the driver', async () => {
  const done = await api.post(`/routes/stops/${order.pickup_stop_id}/status`).set(as(staff)).send({ action: 'complete' });
  assert.equal(done.status, 200);
  assert.equal(done.body.stops[0].status, 'completed');
  const detail = await api.get(`/orders/${order.id}`).set(as(staff));
  assert.equal(detail.body.status, 'picked_up');
  assert.equal(detail.body.events.at(-1).actor_type, 'user');
});
