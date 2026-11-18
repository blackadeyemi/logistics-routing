// Loads realistic Lagos demo data: staff accounts, vehicles, drivers,
// today's orders, and one route already planned for the first driver.
//
//   npm run seed            refuses if data already exists
//   npm run seed -- --reset wipes all tables first
//
// Logins: admin@example.com and dispatcher@example.com, password from
// SEED_PASSWORD (default password123). Drivers log in with PIN 1234.
//
// --reset keeps app_settings (the saved API keys) and the ai_usage history:
// TRUNCATE ... CASCADE through users would otherwise wipe both.
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { pool, withTransaction } = require('../src/db');
const { reindexAll } = require('../src/knowledge');

const PASSWORD = process.env.SEED_PASSWORD || 'password123';
const DRIVER_PIN = '1234';

const places = {
  ikejaMall: ['Ikeja City Mall, Obafemi Awolowo Way, Alausa, Ikeja', 6.6142, 3.3581],
  allen: ['15 Allen Avenue, Ikeja', 6.6018, 3.3515],
  yaba: ['Tejuosho Market, Yaba', 6.5095, 3.3711],
  surulere: ['Adeniran Ogunsanya Street, Surulere', 6.5006, 3.3581],
  vi: ['Adeola Odeku Street, Victoria Island', 6.4281, 3.4219],
  lekki1: ['12 Admiralty Way, Lekki Phase 1', 6.4474, 3.4723],
  ikoyi: ['Awolowo Road, Ikoyi', 6.4549, 3.4366],
  ajah: ['Ajah Market, Lekki Epe Expressway, Ajah', 6.4698, 3.5852],
  maryland: ['Maryland Mall, Ikorodu Road, Maryland', 6.5711, 3.3672],
  festac: ['23 Road, Festac Town', 6.4667, 3.2833],
  gbagada: ['Gbagada Phase 2, Gbagada', 6.5546, 3.3891],
  oshodi: ['Oshodi Interchange, Oshodi', 6.5550, 3.3437],
  apapa: ['Wharf Road, Apapa', 6.4489, 3.3590],
  ogba: ['Ogba Retail Market, Ogba', 6.6237, 3.3416],
  magodo: ['Magodo Phase 2, Shangisha', 6.6200, 3.3800],
  ojota: ['Ojota Bus Stop, Ikorodu Road, Ojota', 6.5856, 3.3784],
};

// [customer, phone, pickup place, dropoff place, pickup notes, dropoff notes]
const orders = [
  ['Chioma Okafor', '08031110001', 'ikejaMall', 'lekki1', null, 'Black gate opposite the Mobil filling station. Call on arrival.'],
  ['Tunde Bakare', '08031110002', 'allen', 'vi', 'Ask for Mr Ade at the electronics shop upstairs.', 'Office building: deliver to reception on the ground floor.'],
  ['Aisha Bello', '08031110003', 'yaba', 'surulere', 'Shop C14 inside the market, ask for Iya Bisi.', 'Collect ₦18,000 on delivery.'],
  ['Emeka Nwosu', '08031110004', 'maryland', 'ikoyi', null, 'Flat 3, second floor. The doorbell is broken, call 5 minutes before arriving.'],
  ['Funke Adeyemi', '08031110005', 'ogba', 'magodo', null, 'Magodo estate gate: tell security you are going to House 24, Adekunle Kuye Street.'],
  ['Ibrahim Musa', '08031110006', 'oshodi', 'festac', null, 'House 4 on 23 Road. Collect ₦7,500. Customer is only home after 4pm.'],
  ['Ngozi Eze', '08031110007', 'gbagada', 'yaba', 'Birthday cake from Sweet Bites bakery. Keep the box flat.', null],
  ['Segun Ogunleye', '08031110008', 'vi', 'ajah', null, 'Shop 112 near the main entrance of the market. Park on the Shoprite side.'],
  ['Halima Yusuf', '08031110009', 'apapa', 'surulere', 'Gate 2 of the port complex: show the waybill to security.', null],
  ['Kunle Afolabi', '08031110010', 'ojota', 'allen', null, null],
  ['Blessing Okon', '08031110011', 'ikoyi', 'lekki1', null, 'Gate code 4471. Tell security you are for the Okon family.'],
  ['Yemi Alade', '08031110012', 'festac', 'apapa', null, null],
  ['Obinna Chukwu', '08031110013', 'magodo', 'ojota', 'House with the green gate on Jide Oki Street, Phase 2.', null],
  ['Zainab Ahmed', '08031110014', 'surulere', 'gbagada', null, 'Fragile glass vase. Do not leave it with the gateman.'],
  ['Femi Oladipo', '08031110015', 'lekki1', 'ajah', null, 'Customer pays by transfer: wait for the dispatcher to confirm payment before handing over.'],
  ['Amaka Obi', '08031110016', 'ikejaMall', 'maryland', null, null],
];

async function main() {
  const reset = process.argv.includes('--reset');
  await withTransaction(async (db) => {
    const { rows } = await db.query('SELECT count(*) AS n FROM users');
    if (rows[0].n > 0 && !reset) {
      throw new Error('Database already has data. Run with --reset to wipe it first.');
    }
    if (reset) {
      const { rows: settings } = await db.query('SELECT key, value, updated_at FROM app_settings');
      const { rows: usage } = await db.query(
        'SELECT feature, model, input_tokens, output_tokens, cache_read_tokens, duration_ms, ok, created_at FROM ai_usage',
      );
      await db.query(`TRUNCATE order_events, stops, routes, orders, drivers, vehicles, users,
                        knowledge_chunks, knowledge_documents, agent_actions, agent_conversations
                      RESTART IDENTITY CASCADE`);
      // CASCADE emptied these too (they reference users). Put them back
      // without the user links, which no longer exist.
      for (const r of settings) {
        await db.query('INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, $3)', [r.key, r.value, r.updated_at]);
      }
      for (const u of usage) {
        await db.query(
          `INSERT INTO ai_usage (feature, model, input_tokens, output_tokens, cache_read_tokens, duration_ms, ok, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [u.feature, u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.duration_ms, u.ok, u.created_at],
        );
      }
    }

    const hash = await bcrypt.hash(PASSWORD, 10);
    await db.query(
      `INSERT INTO users (email, password_hash, full_name, role) VALUES
       ('admin@example.com', $1, 'Ada Admin', 'admin'),
       ('dispatcher@example.com', $1, 'Dayo Dispatcher', 'dispatcher')`,
      [hash],
    );

    const { rows: vehicles } = await db.query(
      `INSERT INTO vehicles (type, plate_number, capacity_kg) VALUES
       ('bike', 'LAG-101-AA', 20), ('bike', 'LAG-102-AA', 20),
       ('keke', 'KJA-203-BB', 150), ('van', 'EKY-404-CC', 800)
       RETURNING id`,
    );

    const pin = await bcrypt.hash(DRIVER_PIN, 10);
    const drivers = [
      ['Musa Abdullahi', '+2348020000001', vehicles[0].id],
      ['Chinedu Okeke', '+2348020000002', vehicles[1].id],
      ['Sola Adebayo', '+2348020000003', vehicles[2].id],
      ['Peter Etim', '+2348020000004', vehicles[3].id],
      ['Gbenga Lawal', '+2348020000005', null],
    ];
    const driverIds = [];
    for (const [name, phone, vehicleId] of drivers) {
      const { rows: d } = await db.query(
        'INSERT INTO drivers (name, phone, vehicle_id, pin_hash) VALUES ($1, $2, $3, $4) RETURNING id',
        [name, phone, vehicleId, pin],
      );
      driverIds.push(d[0].id);
    }

    const stopPairs = [];
    for (const [name, phone, from, to, pickupNotes, dropoffNotes] of orders) {
      const [pAddr, pLat, pLng] = places[from];
      const [dAddr, dLat, dLng] = places[to];
      const { rows: o } = await db.query(
        `INSERT INTO orders (customer_name, customer_phone, pickup_address, pickup_location,
                             dropoff_address, dropoff_location)
         VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography,
                 $6, ST_SetSRID(ST_MakePoint($8, $7), 4326)::geography)
         RETURNING id, pickup_location, dropoff_location`,
        [name, `+234${phone.slice(1)}`, pAddr, pLat, pLng, dAddr, dLat, dLng],
      );
      const { rows: s } = await db.query(
        `INSERT INTO stops (order_id, stop_type, address, location, notes) VALUES
         ($1, 'pickup', $2, $3, $6), ($1, 'dropoff', $4, $5, $7) RETURNING id`,
        [o[0].id, pAddr, o[0].pickup_location, dAddr, o[0].dropoff_location, pickupNotes, dropoffNotes],
      );
      await db.query(
        "INSERT INTO order_events (order_id, event_type, actor_type, actor_id) VALUES ($1, 'created', 'user', 2)",
        [o[0].id],
      );
      stopPairs.push({ orderId: o[0].id, pickup: s[0].id, dropoff: s[1].id });
    }

    // Plan today's route for the first driver with the first three orders,
    // all pickups first and then the dropoffs.
    const { rows: r } = await db.query(
      `INSERT INTO routes (driver_id, vehicle_id, route_date)
       VALUES ($1, $2, (now() AT TIME ZONE 'Africa/Lagos')::date) RETURNING id`,
      [driverIds[0], vehicles[0].id],
    );
    const planned = stopPairs.slice(0, 3);
    const sequence = [...planned.map((p) => p.pickup), ...planned.map((p) => p.dropoff)];
    for (const [i, stopId] of sequence.entries()) {
      await db.query('UPDATE stops SET route_id = $1, sequence_number = $2 WHERE id = $3', [r[0].id, i + 1, stopId]);
    }
    for (const p of planned) {
      await db.query("UPDATE orders SET status = 'assigned' WHERE id = $1", [p.orderId]);
      await db.query(
        "INSERT INTO order_events (order_id, event_type, actor_type, actor_id) VALUES ($1, 'assigned', 'user', 2)",
        [p.orderId],
      );
    }

    // Company SOPs for knowledge search, from scripts/knowledge/*.md. The
    // first line is the title.
    const dir = path.join(__dirname, 'knowledge');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');
      const [first, ...rest] = text.split('\n');
      await db.query(
        'INSERT INTO knowledge_documents (title, body, created_by) VALUES ($1, $2, 1)',
        [first.replace(/^#\s*/, '').trim(), rest.join('\n').trim()],
      );
    }
  });

  console.log('Seeded: 2 staff, 4 vehicles, 5 drivers, %d orders, 1 planned route, SOP documents.', orders.length);
  try {
    const r = await reindexAll();
    console.log('Knowledge indexed: %d chunks from %d documents and %d orders with notes.', r.chunks, r.documents, r.orders_with_notes);
  } catch (err) {
    console.warn('Knowledge not indexed (%s). Run POST /knowledge/reindex once service-python is up.', err.message);
  }
  console.log('Staff password: %s   Driver PIN: %s', PASSWORD, DRIVER_PIN);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
