const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { asyncHandler, HttpError } = require('../errors');
const { z, parse, phone, idParam, id } = require('../validation');
const { requireAuth, STAFF } = require('../auth');

const router = express.Router();
router.use(requireAuth(...STAFF));

// pin_hash is never returned; has_pin tells the dashboard whether the
// driver can log in yet.
const SELECT = `
  SELECT d.id, d.name, d.phone, d.email, d.vehicle_id, d.status, d.created_at,
         d.pin_hash IS NOT NULL AS has_pin,
         CASE WHEN v.id IS NULL THEN NULL ELSE json_build_object(
           'id', v.id, 'type', v.type, 'plate_number', v.plate_number,
           'capacity_kg', v.capacity_kg, 'status', v.status) END AS vehicle
  FROM drivers d LEFT JOIN vehicles v ON v.id = d.vehicle_id`;

const fields = {
  name: z.string().trim().min(1).max(255),
  phone,
  email: z.string().email().transform((v) => v.toLowerCase()).nullable(),
  vehicle_id: id.nullable(),
  status: z.enum(['active', 'inactive']),
};

const createDriver = z.object({
  ...fields,
  email: fields.email.optional().default(null),
  vehicle_id: fields.vehicle_id.optional().default(null),
  status: fields.status.default('active'),
  pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits').optional(),
});
const updateDriver = z.object(fields).partial();

async function getDriver(driverId) {
  const { rows } = await pool.query(`${SELECT} WHERE d.id = $1`, [driverId]);
  if (!rows[0]) throw new HttpError(404, 'Driver not found');
  return rows[0];
}

router.get('/', asyncHandler(async (req, res) => {
  const { status } = parse(z.object({ status: fields.status.optional() }), req.query);
  const { rows } = await pool.query(
    `${SELECT} WHERE ($1::text IS NULL OR d.status = $1) ORDER BY d.name`,
    [status ?? null],
  );
  res.json(rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json(await getDriver(idParam(req)));
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = parse(createDriver, req.body);
  const hash = b.pin ? await bcrypt.hash(b.pin, 10) : null;
  const { rows } = await pool.query(
    `INSERT INTO drivers (name, phone, email, vehicle_id, status, pin_hash)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [b.name, b.phone, b.email, b.vehicle_id, b.status, hash],
  );
  res.status(201).json(await getDriver(rows[0].id));
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const driverId = idParam(req);
  const b = parse(updateDriver, req.body);
  const { rowCount } = await pool.query(
    `UPDATE drivers SET
       name = COALESCE($2, name),
       phone = COALESCE($3, phone),
       email = CASE WHEN $4::boolean THEN $5 ELSE email END,
       vehicle_id = CASE WHEN $6::boolean THEN $7::bigint ELSE vehicle_id END,
       status = COALESCE($8, status)
     WHERE id = $1`,
    [driverId, b.name ?? null, b.phone ?? null,
      'email' in b, b.email ?? null,
      'vehicle_id' in b, b.vehicle_id ?? null,
      b.status ?? null],
  );
  if (!rowCount) throw new HttpError(404, 'Driver not found');
  res.json(await getDriver(driverId));
}));

// Set or reset the PIN the driver uses to log in to the PWA.
router.put('/:id/pin', asyncHandler(async (req, res) => {
  const { pin } = parse(z.object({ pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits') }), req.body);
  const hash = await bcrypt.hash(pin, 10);
  const { rowCount } = await pool.query('UPDATE drivers SET pin_hash = $2 WHERE id = $1', [idParam(req), hash]);
  if (!rowCount) throw new HttpError(404, 'Driver not found');
  res.status(204).end();
}));

// Drivers with route history are kept for the record, set them inactive.
router.delete('/:id', asyncHandler(async (req, res) => {
  const driverId = idParam(req);
  const { rows } = await pool.query('SELECT 1 FROM routes WHERE driver_id = $1 LIMIT 1', [driverId]);
  if (rows[0]) throw new HttpError(409, 'Driver has routes, set status to inactive instead');
  const { rowCount } = await pool.query('DELETE FROM drivers WHERE id = $1', [driverId]);
  if (!rowCount) throw new HttpError(404, 'Driver not found');
  res.status(204).end();
}));

module.exports = router;
