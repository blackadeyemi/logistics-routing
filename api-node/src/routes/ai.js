// AI features for the dashboard. api-node checks auth, adds the Anthropic
// key and model from settings, calls service-python, and logs token usage.
const express = require('express');
const { pool } = require('../db');
const { asyncHandler, HttpError } = require('../errors');
const { z, parse } = require('../validation');
const { requireAuth, STAFF } = require('../auth');
const { callAi, requireConfig, logUsage } = require('../ai');

const router = express.Router();
router.use(requireAuth(...STAFF));

// Paste a WhatsApp message, get a draft order to review. Nothing is saved
// as an order here: the dispatcher checks the draft and saves it through
// POST /orders like any other order.
router.post('/extract-order', asyncHandler(async (req, res) => {
  const { message, model: override } = parse(z.object({
    message: z.string().trim().min(5, 'Paste the message first').max(4000),
    // Admins can name a model for one request, which is how the evals
    // compare models. Everyone else gets the model chosen in Settings.
    model: z.string().regex(/^claude-[a-z0-9.-]+$/).optional(),
  }).strict(), req.body);
  if (override && req.user.role !== 'admin') throw new HttpError(403, 'Only admins can choose the model per request');
  const cfg = await requireConfig();
  if (override) cfg.model = override;
  try {
    const result = await callAi('/ai/extract-order', { model: cfg.model, message }, { apiKey: cfg.apiKey, timeoutMs: 90_000 });
    await logUsage(req.user.id, 'extract_order', cfg.model, result.usage, true);
    res.json({ ...result, model: result.usage?.model ?? cfg.model });
  } catch (err) {
    await logUsage(req.user.id, 'extract_order', cfg.model, null, false);
    throw err;
  }
}));

module.exports = router;
