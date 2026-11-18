// Writes the copilot can propose. The agent never applies one: it records a
// proposal here, the dispatcher reads the preview and confirms or rejects
// it in the chat panel, and only then api-node applies it through its own
// public endpoints with the confirming user's token. Validation, auth and
// dispatch rules are therefore exactly the ones the dashboard uses.
const http = require('node:http');
const { pool, TODAY_SQL } = require('./db');
const { HttpError } = require('./errors');
const { z, phone, id, isoDate } = require('./validation');
const { fmtPhoneLocal } = require('./format');

const note = z.string().trim().max(1000).nullable().optional();

const TOOLS = {
  create_order: {
    schema: z.object({
      customer_name: z.string().trim().min(1).max(255),
      customer_phone: phone,
      pickup_address: z.string().trim().min(1),
      dropoff_address: z.string().trim().min(1),
      pickup_notes: note,
      dropoff_notes: note,
    }).strict(),
    async preview(a) {
      return {
        summary: `Create an order for ${a.customer_name} (${fmtPhoneLocal(a.customer_phone)}): ${a.pickup_address} to ${a.dropoff_address}`,
        details: a,
      };
    },
    async apply(a, call) {
      const order = await call('POST', '/orders', a);
      return { order_id: order.id, message: `Order #${order.id} created` };
    },
  },

  update_order: {
    schema: z.object({
      order_id: id,
      customer_name: z.string().trim().min(1).max(255).optional(),
      customer_phone: phone.optional(),
      pickup_address: z.string().trim().min(1).optional(),
      dropoff_address: z.string().trim().min(1).optional(),
      pickup_notes: note,
      dropoff_notes: note,
    }).strict().refine((a) => Object.keys(a).length > 1, 'Say what to change'),
    async preview(a, db) {
      const o = await orderRow(db, a.order_id);
      const { order_id: _, ...changes } = a;
      const list = Object.entries(changes).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${o[k] ?? 'empty'} to ${v ?? 'empty'}`);
      return { summary: `Update order #${o.id} (${o.customer_name}): ${list.join('; ')}`, details: { order_id: o.id, changes } };
    },
    async apply(a, call) {
      const { order_id: orderId, ...changes } = a;
      await call('PATCH', `/orders/${orderId}`, changes);
      return { order_id: orderId, message: `Order #${orderId} updated` };
    },
  },

  cancel_order: {
    schema: z.object({ order_id: id }).strict(),
    async preview(a, db) {
      const o = await orderRow(db, a.order_id);
      if (!['pending', 'assigned'].includes(o.status)) throw new HttpError(409, `Order #${o.id} is ${o.status} and cannot be cancelled`);
      return { summary: `Cancel order #${o.id} for ${o.customer_name} (${o.status})`, details: { order_id: o.id } };
    },
    async apply(a, call) {
      await call('POST', `/orders/${a.order_id}/cancel`, {});
      return { order_id: a.order_id, message: `Order #${a.order_id} cancelled` };
    },
  },

  // Sets a driver's whole stop list for a day, creating the route if the
  // driver has none. The list replaces what is there, like the planner.
  assign_stops: {
    schema: z.object({
      driver_id: id,
      route_date: isoDate.optional(),
      stop_ids: z.array(id).min(1).max(200),
    }).strict(),
    async preview(a, db) {
      const { rows: d } = await db.query('SELECT id, name, status FROM drivers WHERE id = $1', [a.driver_id]);
      if (!d[0]) throw new HttpError(404, `Driver ${a.driver_id} not found`);
      const { rows: day } = await db.query(`SELECT COALESCE($1::date, ${TODAY_SQL})::text AS d`, [a.route_date ?? null]);
      const date = day[0].d;
      const { rows: stops } = await db.query(
        `SELECT s.id, s.order_id, s.stop_type, s.address, s.status, s.route_id, o.customer_name, o.status AS order_status
         FROM stops s JOIN orders o ON o.id = s.order_id WHERE s.id = ANY($1)`,
        [a.stop_ids],
      );
      const byId = new Map(stops.map((s) => [Number(s.id), s]));
      const missing = a.stop_ids.filter((sid) => !byId.has(sid));
      if (missing.length) throw new HttpError(404, `Unknown stop ids: ${missing.join(', ')}`);
      const { rows: current } = await db.query(
        'SELECT r.id, (SELECT count(*) FROM stops WHERE route_id = r.id) AS n FROM routes r WHERE r.driver_id = $1 AND r.route_date = $2',
        [a.driver_id, date],
      );
      // Warn about what the API would reject, so the copilot can fix it
      // before the dispatcher sees the proposal.
      const problems = [];
      const pos = new Map(a.stop_ids.map((sid, i) => [`${byId.get(sid).order_id}:${byId.get(sid).stop_type}`, i]));
      for (const s of stops) {
        const other = `${s.order_id}:${s.stop_type === 'pickup' ? 'dropoff' : 'pickup'}`;
        if (!pos.has(other) && s.status === 'pending') problems.push(`Order #${s.order_id} has only its ${s.stop_type} in the list: add both stops`);
        if (s.stop_type === 'dropoff' && pos.has(other) && pos.get(other) > pos.get(`${s.order_id}:dropoff`)) problems.push(`Order #${s.order_id}: dropoff comes before its pickup`);
        if (s.order_status === 'cancelled') problems.push(`Order #${s.order_id} is cancelled`);
      }
      if (problems.length) throw new HttpError(409, [...new Set(problems)].join('. '));
      const orders = [...new Set(stops.map((s) => Number(s.order_id)))];
      const existing = current[0] ? ` (replaces its current ${current[0].n} stops)` : ' (new route)';
      return {
        summary: `Plan ${d[0].name}'s route for ${date}: ${a.stop_ids.length} stops for orders ${orders.map((o) => `#${o}`).join(', ')}${existing}`,
        details: {
          driver: d[0].name, route_date: date,
          stops: a.stop_ids.map((sid, i) => {
            const s = byId.get(sid);
            return { n: i + 1, stop_id: sid, type: s.stop_type, address: s.address, order_id: Number(s.order_id), customer: s.customer_name };
          }),
        },
      };
    },
    async apply(a, call, db) {
      const { rows: day } = await db.query(`SELECT COALESCE($1::date, ${TODAY_SQL})::text AS d`, [a.route_date ?? null]);
      const date = day[0].d;
      const routes = await call('GET', `/routes?date=${date}&driver_id=${a.driver_id}`);
      const route = routes[0] ?? await call('POST', '/routes', { driver_id: a.driver_id, route_date: date });
      await call('PUT', `/routes/${route.id}/stops`, { stop_ids: a.stop_ids });
      return { route_id: route.id, message: `Route #${route.id} for ${date} now has ${a.stop_ids.length} stops` };
    },
  },

  update_stop_status: {
    schema: z.object({ stop_id: id, action: z.enum(['arrive', 'start', 'complete', 'skip']) }).strict(),
    async preview(a, db) {
      const { rows } = await db.query(
        `SELECT s.id, s.stop_type, s.address, s.status, s.order_id, s.route_id, o.customer_name
         FROM stops s JOIN orders o ON o.id = s.order_id WHERE s.id = $1`,
        [a.stop_id],
      );
      const s = rows[0];
      if (!s) throw new HttpError(404, `Stop ${a.stop_id} not found`);
      if (!s.route_id) throw new HttpError(409, `Stop ${a.stop_id} is not on a route`);
      const verb = { arrive: 'arrived at', start: 'started the trip to', complete: s.stop_type === 'pickup' ? 'picked up from' : 'delivered to', skip: s.stop_type === 'pickup' ? 'could not pick up from' : 'could not deliver to' }[a.action];
      return { summary: `Record that the driver ${verb} the ${s.stop_type} at ${s.address} (order #${s.order_id}, ${s.customer_name})`, details: { ...a, order_id: Number(s.order_id) } };
    },
    async apply(a, call) {
      await call('POST', `/routes/stops/${a.stop_id}/status`, { action: a.action });
      return { stop_id: a.stop_id, message: `Stop ${a.stop_id}: ${a.action} recorded` };
    },
  },
};

async function orderRow(db, orderId) {
  const { rows } = await db.query(
    `SELECT o.id, o.customer_name, o.customer_phone, o.pickup_address, o.dropoff_address, o.status,
            ps.notes AS pickup_notes, ds.notes AS dropoff_notes
     FROM orders o
     LEFT JOIN stops ps ON ps.order_id = o.id AND ps.stop_type = 'pickup'
     LEFT JOIN stops ds ON ds.order_id = o.id AND ds.stop_type = 'dropoff'
     WHERE o.id = $1`,
    [orderId],
  );
  if (!rows[0]) throw new HttpError(404, `Order #${orderId} not found`);
  return rows[0];
}

/** Validates and previews a proposal. Throws HttpError the agent can read. */
async function proposeAction(tool, args) {
  const t = TOOLS[tool];
  if (!t) throw new HttpError(400, `Unknown write tool ${tool}`);
  const parsed = t.schema.safeParse(args);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
  }
  const p = await t.preview(parsed.data, pool);
  return { arguments: parsed.data, summary: p.summary, preview: p.details };
}

// In-process HTTP to this same app, so a confirmed proposal goes through the
// public endpoints. A private listener on 127.0.0.1 also works in tests.
let internal = null;
function internalPort() {
  if (!internal) {
    internal = new Promise((resolve) => {
      // Required lazily: app.js requires the routes that require this file.
      // eslint-disable-next-line global-require
      const server = require('./app').listen(0, '127.0.0.1', () => resolve(server.address().port));
      server.unref();
    });
  }
  return internal;
}

function callerFor(authorization) {
  return async (method, path, body) => {
    const port = await internalPort();
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path, method,
        headers: { Authorization: authorization, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
      }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          const json = text ? JSON.parse(text) : null;
          if (res.statusCode >= 400) {
            const extra = Array.isArray(json?.details) ? `: ${json.details.map((d) => d.message ?? d).join('; ')}` : '';
            reject(new HttpError(res.statusCode, `${json?.error ?? 'Request failed'}${extra}`));
          } else resolve(json);
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  };
}

async function applyAction(tool, args, authorization) {
  return TOOLS[tool].apply(args, callerFor(authorization), pool);
}

module.exports = { WRITE_TOOLS: Object.keys(TOOLS), proposeAction, applyAction };
