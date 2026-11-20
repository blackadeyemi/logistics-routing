// Quick end-to-end check of Phase 4 against a running stack on the seeded
// day: WebSocket events, location upload with ETAs, stop updates, the
// automatic SMS and the public tracking page. Run from api-node:
//   node scripts/smoke-live.js [http://localhost:3100]
const WebSocket = require('ws');

const BASE = process.argv[2] || 'http://localhost:3100';

async function call(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

(async () => {
  const staff = (await call('POST', '/auth/login', null, { email: 'dispatcher@example.com', password: 'password123' })).token;
  const driver = (await call('POST', '/auth/driver-login', null, { phone: '08020000001', pin: '1234' })).token;
  const events = [];
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?token=${staff}`);
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.on('message', (m) => events.push(JSON.parse(m)));

  const { route } = await call('GET', '/driver/route', driver);
  const first = route.stops[0];
  // A point just north of the first pickup.
  const at = new Date().toISOString();
  const up = await call('POST', '/driver/locations', driver, { points: [{ lat: first.location.lat + 0.01, lng: first.location.lng, accuracy_m: 12, app_visible: true, recorded_at: at }] });
  const again = await call('POST', '/driver/locations', driver, { points: [{ lat: first.location.lat + 0.01, lng: first.location.lng, recorded_at: at }] });

  await call('POST', `/driver/stops/${first.id}/status`, driver, { action: 'complete' });
  const drop = route.stops.find((s) => s.order_id === first.order_id && s.stop_type === 'dropoff');
  await call('POST', `/driver/stops/${drop.id}/status`, driver, { action: 'start' });
  await new Promise((r) => { setTimeout(r, 800); });

  const live = await call('GET', '/live', staff);
  const order = await call('GET', `/orders/${first.order_id}`, staff);
  const token = order.tracking_url.split('/').pop();
  const track = await call('GET', `/public/track/${token}`);
  const quality = await call('GET', '/live/tracking-quality', staff);
  ws.close();

  const loc = events.find((e) => e.type === 'location');
  console.log(JSON.stringify({
    ws_events: events.map((e) => e.type),
    location_event_eta_stops: loc?.eta?.length ?? 0,
    first_eta_minutes: loc?.eta?.[0]?.minutes,
    uploads: [up.accepted, again.accepted],
    live_route: { driver: live.routes[0].driver, eta_from: live.routes[0].eta_from, has_location: !!live.routes[0].location },
    order_sms: order.sms.map((m) => `${m.reason}:${m.status}:${m.body}`),
    tracking_url: order.tracking_url,
    public: { status: track.status, first_name: track.customer_first_name, eta: track.eta, driver: track.driver, events: track.events.map((e) => e.type), phone_leak: JSON.stringify(track).includes('+234') },
    quality: quality.drivers.map((d) => ({ driver: d.driver, points: d.points })),
  }, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });
