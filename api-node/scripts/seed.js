// Loads realistic Lagos demo data: staff accounts, vehicles, drivers,
// today's orders, and one route already planned for the first driver.
//
//   npm run seed            refuses if data already exists
//   npm run seed -- --reset wipes all tables first
//
// Logins: admin@example.com and dispatcher@example.com, password from
// SEED_PASSWORD (default password123). Drivers log in with PIN 1234.
require('dotenv').config();
const bcrypt = require('bcrypt');
const { pool, withTransaction } = require('../src/db');

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

const orders = [
  ['Chioma Okafor', '08031110001', 'ikejaMall', 'lekki1'],
  ['Tunde Bakare', '08031110002', 'allen', 'vi'],
  ['Aisha Bello', '08031110003', 'yaba', 'surulere'],
  ['Emeka Nwosu', '08031110004', 'maryland', 'ikoyi'],
  ['Funke Adeyemi', '08031110005', 'ogba', 'magodo'],
  ['Ibrahim Musa', '08031110006', 'oshodi', 'festac'],
  ['Ngozi Eze', '08031110007', 'gbagada', 'yaba'],
  ['Segun Ogunleye', '08031110008', 'vi', 'ajah'],
  ['Halima Yusuf', '08031110009', 'apapa', 'surulere'],
  ['Kunle Afolabi', '08031110010', 'ojota', 'allen'],
  ['Blessing Okon', '08031110011', 'ikoyi', 'lekki1'],
  ['Yemi Alade', '08031110012', 'festac', 'apapa'],
  ['Obinna Chukwu', '08031110013', 'magodo', 'ojota'],
  ['Zainab Ahmed', '08031110014', 'surulere', 'gbagada'],
  ['Femi Oladipo', '08031110015', 'lekki1', 'ajah'],
  ['Amaka Obi', '08031110016', 'ikejaMall', 'maryland'],
];

async function main() {
  const reset = process.argv.includes('--reset');
  await withTransaction(async (db) => {
    const { rows } = await db.query('SELECT count(*) AS n FROM users');
    if (rows[0].n > 0 && !reset) {
      throw new Error('Database already has data. Run with --reset to wipe it first.');
    }
    if (reset) {
      await db.query(`TRUNCATE order_events, stops, routes, orders, drivers, vehicles, users
                      RESTART IDENTITY CASCADE`);
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
    for (const [name, phone, from, to] of orders) {
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
        `INSERT INTO stops (order_id, stop_type, address, location) VALUES
         ($1, 'pickup', $2, $3), ($1, 'dropoff', $4, $5) RETURNING id`,
        [o[0].id, pAddr, o[0].pickup_location, dAddr, o[0].dropoff_location],
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
  });

  console.log('Seeded: 2 staff, 4 vehicles, 5 drivers, %d orders, 1 planned route.', orders.length);
  console.log('Staff password: %s   Driver PIN: %s', PASSWORD, DRIVER_PIN);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
