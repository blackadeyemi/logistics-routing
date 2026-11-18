const express = require('express');
const { pool } = require('../db');
const { asyncHandler, HttpError } = require('../errors');
const { z, parse, idParam } = require('../validation');
const { requireAuth, STAFF } = require('../auth');

const router = express.Router();
router.use(requireAuth(...STAFF));

const COLUMNS = 'id, type, plate_number, capacity_kg, status, created_at';

const fields = {
  type: z.enum(['bike', 'keke', 'van', 'truck']),
  plate_number: z.string().trim().min(1).max(50).transform((v) => v.toUpperCase()),
  capacity_kg: z.number().positive().nullable(),
  status: z.enum(['active', 'maintenance', 'inactive']),
};

const createVehicle = z.object({
  ...fields,
  capacity_kg: fields.capacity_kg.optional().default(null),
  status: fields.status.default('active'),
});
const updateVehicle = z.object(fields).partial();

router.get('/', asyncHandler(async (req, res) => {
  const { status } = parse(z.object({ status: fields.status.optional() }), req.query);
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM vehicles
     WHERE ($1::text IS NULL OR status = $1) ORDER BY id`,
    [status ?? null],
  );
  res.json(rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM vehicles WHERE id = $1`, [idParam(req)]);
  if (!rows[0]) throw new HttpError(404, 'Vehicle not found');
  res.json(rows[0]);
}));

router.post('/', asyncHandler(async (req, res) => {
  const b = parse(createVehicle, req.body);
  const { rows } = await pool.query(
    `INSERT INTO vehicles (type, plate_number, capacity_kg, status)
     VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
    [b.type, b.plate_number, b.capacity_kg, b.status],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const b = parse(updateVehicle, req.body);
  const { rows } = await pool.query(
    `UPDATE vehicles SET
       type = COALESCE($2, type),
       plate_number = COALESCE($3, plate_number),
       capacity_kg = CASE WHEN $4::boolean THEN $5 ELSE capacity_kg END,
       status = COALESCE($6, status)
     WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, b.type ?? null, b.plate_number ?? null, 'capacity_kg' in b, b.capacity_kg ?? null, b.status ?? null],
  );
  if (!rows[0]) throw new HttpError(404, 'Vehicle not found');
  res.json(rows[0]);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM vehicles WHERE id = $1', [idParam(req)]);
  if (!rowCount) throw new HttpError(404, 'Vehicle not found');
  res.status(204).end();
}));

module.exports = router;
