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

module.exports = { aiConfig, callAi, AI_KEYS: KEYS };
