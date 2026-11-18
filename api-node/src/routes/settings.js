// App settings an admin manages from the dashboard.
//
// Google Maps: the key is a browser key that ends up in every staff
// browser anyway, so any logged-in staff member can read it (the dashboard
// needs it to draw maps). Only admins can change it. Its protection is the
// HTTP referrer and API restriction set in Google Cloud, not secrecy.
//
// AI: the Anthropic key is a server secret. It is stored encrypted, only
// admins can set it, and it is never sent back: responses carry a masked
// hint. The model ID is not secret.
const express = require('express');
const { pool } = require('../db');
const { asyncHandler } = require('../errors');
const { z, parse } = require('../validation');
const { requireAuth, STAFF } = require('../auth');
const { encrypt, hint, canEncrypt } = require('../secrets');
const { aiConfig, callAi, AI_KEYS } = require('../ai');

const router = express.Router();

const MAPS = { mapsKey: 'google_maps_api_key', mapId: 'google_maps_map_id' };

async function rowsFor(keys) {
  const { rows } = await pool.query(
    `SELECT s.key, s.value, s.updated_at, u.full_name AS updated_by
     FROM app_settings s LEFT JOIN users u ON u.id = s.updated_by
     WHERE s.key = ANY($1)`,
    [keys],
  );
  return Object.fromEntries(rows.map((r) => [r.key, r]));
}

async function readSettings() {
  const by = await rowsFor([...Object.values(MAPS), ...Object.values(AI_KEYS)]);
  const mapsKey = by[MAPS.mapsKey];
  const ai = await aiConfig();
  const aiRow = by[AI_KEYS.apiKey] ?? by[AI_KEYS.model];
  return {
    google_maps: {
      api_key: mapsKey?.value ?? '',
      map_id: by[MAPS.mapId]?.value ?? '',
      updated_at: mapsKey?.updated_at ?? null,
      updated_by: mapsKey?.updated_by ?? null,
    },
    ai: {
      api_key_set: !!ai.apiKey,
      api_key_hint: hint(ai.apiKey),
      key_source: ai.keySource,
      key_unreadable: ai.keyUnreadable,
      model: ai.model ?? '',
      model_source: ai.modelSource,
      can_save_secrets: canEncrypt(),
      updated_at: aiRow?.updated_at ?? null,
      updated_by: aiRow?.updated_by ?? null,
    },
  };
}

router.get('/', requireAuth(...STAFF), asyncHandler(async (req, res) => {
  res.json(await readSettings());
}));

// Anthropic keys look like sk-ant-api03-...; allow the family, not one version.
const anthropicKey = z.string().trim().max(300)
  .refine((v) => v === '' || /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(v), 'Does not look like an Anthropic API key (sk-ant-…)');

const updateSettings = z.object({
  google_maps: z.object({
    api_key: z.string().trim().max(200)
      .refine((v) => v === '' || /^[A-Za-z0-9_-]{20,200}$/.test(v), 'Does not look like a Google API key')
      .optional(),
    map_id: z.string().trim().max(100)
      .refine((v) => v === '' || /^[A-Za-z0-9_-]+$/.test(v), 'Letters, digits, dashes and underscores only')
      .optional(),
  }).strict().optional(),
  ai: z.object({
    api_key: anthropicKey.optional(),
    model: z.string().trim().max(100)
      .refine((v) => v === '' || /^claude-[a-z0-9.-]+$/.test(v), 'Model IDs look like claude-opus-5-5')
      .optional(),
  }).strict().optional(),
}).strict();

async function saveValue(key, value, userId) {
  if (value === '') {
    await pool.query('DELETE FROM app_settings WHERE key = $1', [key]);
    return;
  }
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, value, userId],
  );
}

router.put('/', requireAuth('admin'), asyncHandler(async (req, res) => {
  const body = parse(updateSettings, req.body);
  const gm = body.google_maps ?? {};
  const ai = body.ai ?? {};
  // Encrypt first so a missing encryption key fails before anything is written.
  const encryptedKey = ai.api_key ? encrypt(ai.api_key) : ai.api_key;
  const changes = [
    [MAPS.mapsKey, gm.api_key], [MAPS.mapId, gm.map_id],
    [AI_KEYS.apiKey, encryptedKey], [AI_KEYS.model, ai.model],
  ].filter(([, v]) => v !== undefined);
  for (const [key, value] of changes) await saveValue(key, value, req.user.id);
  res.json(await readSettings());
}));

// Checks a key (the one typed in, or the saved one) and lists the models
// it can use. Nothing is saved.
router.post('/ai/check', requireAuth('admin'), asyncHandler(async (req, res) => {
  const { api_key: typed } = parse(z.object({ api_key: anthropicKey.optional() }).strict(), req.body ?? {});
  const apiKey = typed || (await aiConfig()).apiKey;
  if (!apiKey) {
    res.status(400).json({ error: 'Enter an API key to check', details: { code: 'no_key' } });
    return;
  }
  const result = await callAi('/ai/models', {}, { apiKey, timeoutMs: 20_000 });
  res.json(result);
}));

module.exports = router;
