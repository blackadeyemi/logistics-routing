// Drives today's routes for demos and tests: each driver with a route logs
// in, then moves toward their next stop in steps, posting positions as the
// driver app would, and taps through each stop (start trip, arrive,
// complete) when they reach it. Positions use the real time, so the live
// map, ETAs, customer SMS and tracking pages behave as on a real day,
// only faster.
//
//   node scripts/simulate-drivers.js                 all drivers with a route
//   node scripts/simulate-drivers.js --drivers 1,2   only these driver phone suffixes
//   options: --api http://localhost:3100  --tick 1500 (ms between steps)
//            --step 400 (metres per step)  --stops 3 (stops per driver, then stop)
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const API = args.api || process.env.API || 'http://localhost:3100';
const TICK = Number(args.tick || 1500);
const STEP_M = Number(args.step || 400);
const MAX_STOPS = Number(args.stops || 1000);
const ONLY = args.drivers ? args.drivers.split(',').map((d) => `0802000000${d.trim()}`) : null;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data?.error ?? ''}`);
  return data;
}

function metres(a, b) {
  const r = (x) => (x * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

async function drive(phone) {
  const { token, driver } = await call('POST', '/auth/driver-login', null, { phone, pin: process.env.SEED_PIN || '1234' });
  let { route } = await call('GET', '/driver/route', token);
  if (!route) return console.log(`${driver.name}: no route today`);
  const open = route.stops.filter((s) => s.status === 'pending' || s.status === 'arrived');
  // Start a little way off the first stop, as if leaving home.
  let here = open[0]?.location ? { lat: open[0].location.lat + 0.012, lng: open[0].location.lng - 0.008 } : null;
  let done = 0;
  for (const stop of open) {
    if (done >= MAX_STOPS) break;
    if (!stop.location || !here) continue;
    if (stop.stop_type === 'dropoff' && stop.status === 'pending') {
      ({ route } = await call('POST', `/driver/stops/${stop.id}/status`, token, { action: 'start' }));
    }
    while (metres(here, stop.location) > 40) {
      const d = metres(here, stop.location);
      const f = Math.min(1, STEP_M / d);
      here = { lat: here.lat + (stop.location.lat - here.lat) * f, lng: here.lng + (stop.location.lng - here.lng) * f };
      await call('POST', '/driver/locations', token, {
        points: [{ lat: here.lat, lng: here.lng, accuracy_m: 8 + Math.round(Math.random() * 10), speed_mps: 8, app_visible: true, recorded_at: new Date().toISOString() }],
      });
      await sleep(TICK);
    }
    if (stop.status === 'pending') await call('POST', `/driver/stops/${stop.id}/status`, token, { action: 'arrive' });
    await sleep(TICK);
    await call('POST', `/driver/stops/${stop.id}/status`, token, { action: 'complete' });
    done += 1;
    console.log(`${driver.name}: ${stop.stop_type} done at ${stop.address}`);
  }
  return console.log(`${driver.name}: finished (${done} stops)`);
}

(async () => {
  const phones = ONLY ?? ['08020000001', '08020000002', '08020000003', '08020000004', '08020000005'];
  await Promise.all(phones.map((p) => drive(p).catch((e) => console.log(`${p}: ${e.message}`))));
})();
