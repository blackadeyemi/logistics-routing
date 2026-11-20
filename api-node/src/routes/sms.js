// SMS outbox: every customer message sent or logged (Phase 4).
const express = require('express');
const { pool } = require('../db');
const { asyncHandler } = require('../errors');
const { z, parse } = require('../validation');
const { requireAuth, STAFF } = require('../auth');
const { smsConfig } = require('../sms');

const router = express.Router();
router.use(requireAuth(...STAFF));

// GET /sms?limit=50
router.get('/', asyncHandler(async (req, res) => {
  const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
  const { rows } = await pool.query(
    `SELECT m.id, m.order_id, m.to_phone, m.body, m.reason, m.provider, m.status, m.error, m.provider_message_id,
            m.created_at, u.full_name AS created_by, o.customer_name
     FROM sms_messages m LEFT JOIN users u ON u.id = m.created_by LEFT JOIN orders o ON o.id = m.order_id
     ORDER BY m.id DESC LIMIT $1`,
    [limit],
  );
  const cfg = await smsConfig();
  res.json({ provider: cfg.provider, messages: rows });
}));

module.exports = router;
