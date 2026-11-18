const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { asyncHandler, HttpError } = require('../errors');
const { z, parse, phone } = require('../validation');
const { signToken, requireAuth } = require('../auth');

const router = express.Router();

// Compared against when the account does not exist, so a missing account
// and a wrong password take the same time and give the same answer.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const staffLogin = z.object({
  email: z.string().email().transform((v) => v.toLowerCase()),
  password: z.string().min(1),
});

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = parse(staffLogin, req.body);
  const { rows } = await pool.query(
    'SELECT id, email, full_name, role, password_hash FROM users WHERE email = $1',
    [email],
  );
  const user = rows[0];
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Invalid email or password');
  res.json({
    token: signToken(user.id, user.role),
    user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role },
  });
}));

const driverLogin = z.object({
  phone,
  pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits'),
});

router.post('/driver-login', asyncHandler(async (req, res) => {
  const { phone: p, pin } = parse(driverLogin, req.body);
  const { rows } = await pool.query(
    `SELECT id, name, phone, pin_hash FROM drivers
     WHERE phone = $1 AND status = 'active'`,
    [p],
  );
  const driver = rows[0];
  const hash = driver && driver.pin_hash ? driver.pin_hash : DUMMY_HASH;
  const ok = await bcrypt.compare(pin, hash);
  if (!driver || !driver.pin_hash || !ok) throw new HttpError(401, 'Invalid phone or PIN');
  res.json({
    token: signToken(driver.id, 'driver'),
    driver: { id: driver.id, name: driver.name, phone: driver.phone },
  });
}));

router.get('/me', requireAuth(), asyncHandler(async (req, res) => {
  if (req.user.role === 'driver') {
    const { rows } = await pool.query(
      'SELECT id, name, phone, vehicle_id, status FROM drivers WHERE id = $1',
      [req.user.id],
    );
    if (!rows[0]) throw new HttpError(401, 'Account no longer exists');
    return res.json({ role: 'driver', driver: rows[0] });
  }
  const { rows } = await pool.query(
    'SELECT id, email, full_name, role FROM users WHERE id = $1',
    [req.user.id],
  );
  if (!rows[0]) throw new HttpError(401, 'Account no longer exists');
  return res.json({ role: rows[0].role, user: rows[0] });
}));

module.exports = router;
