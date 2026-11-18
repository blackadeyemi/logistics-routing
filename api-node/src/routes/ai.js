// AI features for the dashboard. api-node checks auth, adds the Anthropic
// key and model from settings, calls service-python, and logs token usage.
const express = require('express');
const { pool } = require('../db');
const { asyncHandler, HttpError } = require('../errors');
const { z, parse } = require('../validation');
const { requireAuth, STAFF } = require('../auth');
const { aiConfig, callAi } = require('../ai');

const router = express.Router();
router.use(requireAuth(...STAFF));

async function requireConfig() {
  const cfg = await aiConfig();
  if (!cfg.apiKey) throw new HttpError(409, 'AI is not set up. An admin can add an Anthropic API key on the Settings page.', { code: 'not_configured' });
  if (!cfg.model) throw new HttpError(409, 'No AI model is selected. An admin can pick one on the Settings page.', { code: 'not_configured' });
  return cfg;
}

async function logUsage(userId, feature, model, usage, ok) {
  await pool.query(
    `INSERT INTO ai_usage (user_id, feature, model, input_tokens, output_tokens, cache_read_tokens, duration_ms, ok)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [userId, feature, usage?.model || model, usage?.input_tokens ?? 0, usage?.output_tokens ?? 0,
      usage?.cache_read_tokens ?? 0, usage?.duration_ms ?? null, ok],
  );
}

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
