// Customer SMS with a tracking link (Phase 4).
//
// Sent automatically when the driver starts the trip to the customer
// ("en_route") and when the order is delivered, and by hand from the order
// page. Every message is recorded in sms_messages. Providers:
//   log     nothing leaves the server; the dashboard's SMS outbox shows
//           what the customer would receive (the default)
//   termii  Termii's SMS API (POST {base_url}/api/sms/send), the base URL
//           and sender ID from the Termii dashboard
// An admin sets the provider on the Settings page; the Termii key is
// stored encrypted like the Anthropic key. .env values are the fallback.
const { pool } = require('./db');
const { decrypt } = require('./secrets');

const KEYS = {
  provider: 'sms_provider', baseUrl: 'termii_base_url', apiKey: 'termii_api_key',
  senderId: 'termii_sender_id', channel: 'termii_channel', publicUrl: 'public_app_url', company: 'company_name',
};

async function smsConfig(db = pool) {
  const { rows } = await db.query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [Object.values(KEYS)]);
  const by = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const env = process.env;
  const savedKey = decrypt(by[KEYS.apiKey]);
  return {
    provider: by[KEYS.provider] || env.SMS_PROVIDER || 'log',
    baseUrl: (by[KEYS.baseUrl] || env.TERMII_BASE_URL || '').replace(/\/$/, ''),
    apiKey: savedKey || env.TERMII_API_KEY || null,
    keySource: savedKey ? 'settings' : env.TERMII_API_KEY ? 'env' : 'none',
    keyUnreadable: !!by[KEYS.apiKey] && !savedKey,
    senderId: by[KEYS.senderId] || env.TERMII_SENDER_ID || '',
    channel: by[KEYS.channel] || env.TERMII_CHANNEL || 'dnd',
    publicUrl: (by[KEYS.publicUrl] || env.PUBLIC_APP_URL || 'http://logistics-routing.test').replace(/\/$/, ''),
    company: by[KEYS.company] || env.COMPANY_NAME || '',
  };
}

const trackingUrl = (cfg, token) => `${cfg.publicUrl}/track/${token}`;
const firstName = (name) => (name || '').trim().split(/\s+/)[0] || 'there';

// Short and plain: under 160 characters with a typical link, and no
// characters that would drop the SMS to 70-character segments.
function messageFor(reason, order, cfg) {
  const link = trackingUrl(cfg, order.tracking_token);
  const what = cfg.company ? `your ${cfg.company} delivery` : 'your delivery';
  const hi = `Hi ${firstName(order.customer_name)}`;
  if (reason === 'en_route') return `${hi}, ${what} is on the way. Track it here: ${link}`;
  if (reason === 'delivered') return `${hi}, ${what} has been delivered. Thank you. Details: ${link}`;
  return `${hi}, track ${what} here: ${link}`;
}

async function sendTermii(cfg, to, body) {
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.senderId) {
    return { status: 'failed', error: 'Termii is not fully set up: base URL, API key and sender ID are all needed' };
  }
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/api/sms/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Termii wants the international number without the plus: 2348031234567.
      body: JSON.stringify({ api_key: cfg.apiKey, to: to.replace(/^\+/, ''), from: cfg.senderId, sms: body, type: 'plain', channel: cfg.channel }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { status: 'failed', error: `Could not reach Termii: ${err.message}` };
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.code === 'ok') return { status: 'sent', providerMessageId: data.message_id_str ?? String(data.message_id ?? '') };
  return { status: 'failed', error: `Termii ${res.status}: ${data.message ?? JSON.stringify(data).slice(0, 200)}` };
}

/**
 * Sends (or logs) one SMS about an order. Automatic reasons go out at most
 * once per order: the unique index on (order_id, reason) is the guard.
 * Returns the sms_messages row, or null if it was a duplicate.
 */
async function sendOrderSms(orderId, reason, userId = null) {
  const cfg = await smsConfig();
  const { rows: o } = await pool.query('SELECT id, customer_name, customer_phone, tracking_token FROM orders WHERE id = $1', [orderId]);
  if (!o[0]) return null;
  const body = messageFor(reason, o[0], cfg);
  const { rows: claimed } = await pool.query(
    `INSERT INTO sms_messages (order_id, to_phone, body, reason, provider, status, created_by)
     VALUES ($1, $2, $3, $4, $5, 'logged', $6)
     ON CONFLICT DO NOTHING RETURNING id`,
    [orderId, o[0].customer_phone, body, reason, cfg.provider, userId],
  );
  if (!claimed[0]) return null;
  let result = { status: 'logged' };
  if (cfg.provider === 'termii') result = await sendTermii(cfg, o[0].customer_phone, body);
  const { rows } = await pool.query(
    'UPDATE sms_messages SET status = $2, provider_message_id = $3, error = $4 WHERE id = $1 RETURNING *',
    [claimed[0].id, result.status, result.providerMessageId ?? null, result.error ?? null],
  );
  return rows[0];
}

// Automatic messages must never hold up or fail the driver's update.
function notifyLater(orderId, reason) {
  setImmediate(() => {
    sendOrderSms(orderId, reason).catch((err) => console.warn(`SMS for order ${orderId} failed: ${err.message}`));
  });
}

module.exports = { smsConfig, sendOrderSms, notifyLater, trackingUrl, SMS_KEYS: KEYS, sendTermii };
