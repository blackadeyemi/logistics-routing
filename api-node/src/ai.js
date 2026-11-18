// AI configuration and the internal client for service-python.
//
// The Anthropic key and model come from the Settings page (app_settings,
// key encrypted) and fall back to ANTHROPIC_API_KEY and LLM_MODEL in .env.
// service-python is stateless: api-node sends both with every request, over
// the internal compose network only.
const { pool } = require('./db');
const { decrypt } = require('./secrets');
const { HttpError } = require('./errors');

const KEYS = { apiKey: 'anthropic_api_key', model: 'llm_model' };

async function aiConfig() {
  const { rows } = await pool.query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [Object.values(KEYS)]);
  const by = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const savedKey = decrypt(by[KEYS.apiKey]);
  const envKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  const savedModel = by[KEYS.model] || '';
  const envModel = (process.env.LLM_MODEL || '').trim();
  return {
    apiKey: savedKey || envKey || null,
    keySource: savedKey ? 'settings' : envKey ? 'env' : 'none',
    // Saved but unreadable, for example after SETTINGS_ENCRYPTION_KEY changed.
    keyUnreadable: !!by[KEYS.apiKey] && !savedKey,
    model: savedModel || envModel || null,
    modelSource: savedModel ? 'settings' : envModel ? 'env' : 'none',
  };
}

const serviceUrl = () => (process.env.PYTHON_SERVICE_URL || 'http://service-python:8000').replace(/\/$/, '');

/**
 * POST to service-python with the Anthropic key in a header. Errors from
 * the service come back as HttpError with its message, so the browser sees
 * "the key was rejected" rather than a bare 502.
 */
async function callAi(path, body, { apiKey, timeoutMs = 30_000 } = {}) {
  let res;
  try {
    res = await fetch(`${serviceUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Anthropic-Api-Key': apiKey ?? '' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new HttpError(503, 'The AI service is not reachable. Is service-python running?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status >= 500 ? 502 : res.status, data.detail?.message ?? data.detail ?? 'The AI service failed', data.detail?.code ? { code: data.detail.code } : undefined);
  return data;
}

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

module.exports = { aiConfig, callAi, serviceUrl, requireConfig, logUsage, AI_KEYS: KEYS };
