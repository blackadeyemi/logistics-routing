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
const { smsConfig, deliver, SMS_KEYS } = require('../sms');
const { phone } = require('../validation');

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
  const by = await rowsFor([...Object.values(MAPS), ...Object.values(AI_KEYS), ...Object.values(SMS_KEYS)]);
  const sms = await smsConfig();
  const smsRow = [SMS_KEYS.provider, SMS_KEYS.apiKey, SMS_KEYS.baseUrl, SMS_KEYS.senderId, SMS_KEYS.brevoKey, SMS_KEYS.brevoSender].map((k) => by[k]).filter(Boolean)
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];
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
    // The Termii key is a server secret: only a masked hint comes back.
    sms: {
      provider: sms.provider,
      base_url: sms.baseUrl,
      sender_id: sms.senderId,
      channel: sms.channel,
      api_key_set: !!sms.apiKey,
      api_key_hint: sms.apiKey ? `${sms.apiKey.slice(0, 4)}…${sms.apiKey.slice(-4)}` : null,
      key_source: sms.keySource,
      key_unreadable: sms.keyUnreadable,
      public_app_url: sms.publicUrl,
      company_name: sms.company,
      brevo: {
        sender: sms.brevoSender,
        api_key_set: !!sms.brevoApiKey,
        api_key_hint: sms.brevoApiKey ? `${sms.brevoApiKey.slice(0, 6)}…${sms.brevoApiKey.slice(-4)}` : null,
        key_source: sms.brevoKeySource,
        key_unreadable: sms.brevoKeyUnreadable,
      },
      can_save_secrets: canEncrypt(),
      updated_at: smsRow?.updated_at ?? null,
      updated_by: smsRow?.updated_by ?? null,
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
  sms: z.object({
    provider: z.enum(['log', 'termii', 'brevo']).optional(),
    brevo_api_key: z.string().trim().max(300).refine((v) => v === '' || /^[A-Za-z0-9_-]{20,}$/.test(v), 'Does not look like a Brevo API key (xkeysib-…)').optional(),
    brevo_sender: z.string().trim().max(11).refine((v) => v === '' || /^[A-Za-z0-9]{3,11}$/.test(v), 'Brevo senders are 3 to 11 letters or digits, no spaces').optional(),
    base_url: z.string().trim().max(200).refine((v) => v === '' || /^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(v), 'Use the https base URL from your Termii dashboard, for example https://v3.api.termii.com').optional(),
    api_key: z.string().trim().max(300).refine((v) => v === '' || /^[A-Za-z0-9_\-$]{10,}$/.test(v), 'Does not look like a Termii API key').optional(),
    sender_id: z.string().trim().max(11).refine((v) => v === '' || /^[A-Za-z0-9 ]{3,11}$/.test(v), 'Sender IDs are 3 to 11 letters or digits').optional(),
    channel: z.enum(['dnd', 'generic']).optional(),
    public_app_url: z.string().trim().max(200).refine((v) => v === '' || /^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(v), 'A full address, for example https://track.yourcompany.ng').optional(),
    company_name: z.string().trim().max(40).optional(),
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
  const sms = body.sms ?? {};
  // Encrypt first so a missing encryption key fails before anything is written.
  const encryptedKey = ai.api_key ? encrypt(ai.api_key) : ai.api_key;
  const encryptedSms = sms.api_key ? encrypt(sms.api_key) : sms.api_key;
  const encryptedBrevo = sms.brevo_api_key ? encrypt(sms.brevo_api_key) : sms.brevo_api_key;
  const changes = [
    [SMS_KEYS.provider, sms.provider], [SMS_KEYS.baseUrl, sms.base_url?.replace(/\/$/, '')], [SMS_KEYS.apiKey, encryptedSms],
    [SMS_KEYS.senderId, sms.sender_id], [SMS_KEYS.channel, sms.channel], [SMS_KEYS.publicUrl, sms.public_app_url?.replace(/\/$/, '')],
    [SMS_KEYS.company, sms.company_name], [SMS_KEYS.brevoKey, encryptedBrevo], [SMS_KEYS.brevoSender, sms.brevo_sender],
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

// POST /settings/sms/test { to } : send one test SMS with the saved provider
// settings, so an admin can check them before customers rely on them.
router.post('/sms/test', requireAuth('admin'), asyncHandler(async (req, res) => {
  const { to } = parse(z.object({ to: phone }).strict(), req.body);
  const cfg = await smsConfig();
  if (cfg.provider === 'log') {
    res.status(409).json({ error: 'Choose Termii or Brevo as the SMS provider and save before sending a test' });
    return;
  }
  const body = `Test message from ${cfg.company || 'dispatch'}: SMS is set up.`;
  const result = await deliver(cfg, to, body, 'test');
  // Recorded like any other text, so the outbox shows what the provider said.
  await pool.query(
    `INSERT INTO sms_messages (to_phone, body, reason, provider, status, provider_message_id, error, created_by)
     VALUES ($1, $2, 'test', $3, $4, $5, $6, $7)`,
    [to, body, cfg.provider, result.status, result.providerMessageId ?? null, result.error ?? null, req.user.id],
  );
  res.status(result.status === 'sent' ? 200 : 502).json(result.status === 'sent' ? { ok: true, message_id: result.providerMessageId } : { error: result.error });
}));

module.exports = router;
