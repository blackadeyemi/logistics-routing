const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { asyncHandler, HttpError } = require('../errors');
const { z, parse, idParam } = require('../validation');
const { requireAuth } = require('../auth');

// Staff accounts are managed by admins only.
const router = express.Router();
router.use(requireAuth('admin'));

const COLUMNS = 'id, email, full_name, role, created_at';

const createUser = z.object({
  email: z.string().email().transform((v) => v.toLowerCase()),
  password: z.string().min(8),
  full_name: z.string().trim().min(1).max(255),
  role: z.enum(['admin', 'dispatcher']).default('dispatcher'),
});

const updateUser = z.object({
  full_name: z.string().trim().min(1).max(255).optional(),
  role: z.enum(['admin', 'dispatcher']).optional(),
  password: z.string().min(8).optional(),
});

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM users ORDER BY id`);
  res.json(rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = parse(createUser, req.body);
  const hash = await bcrypt.hash(body.password, 10);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
    [body.email, hash, body.full_name, body.role],
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const body = parse(updateUser, req.body);
  if (id === req.user.id && body.role && body.role !== 'admin') {
    throw new HttpError(400, 'You cannot remove your own admin role');
  }
  const hash = body.password ? await bcrypt.hash(body.password, 10) : null;
  const { rows } = await pool.query(
    `UPDATE users SET
       full_name = COALESCE($2, full_name),
       role = COALESCE($3, role),
       password_hash = COALESCE($4, password_hash)
     WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, body.full_name ?? null, body.role ?? null, hash],
  );
  if (!rows[0]) throw new HttpError(404, 'User not found');
  res.json(rows[0]);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const id = idParam(req);
  if (id === req.user.id) throw new HttpError(400, 'You cannot delete your own account');
  const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, 'User not found');
  res.status(204).end();
}));

module.exports = router;
