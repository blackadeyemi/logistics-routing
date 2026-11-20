// Customer SMS with a tracking link (Phase 4).
//
// Sent automatically when the driver starts the trip to the customer
// ("en_route") and when the order is delivered, and by hand from the order
// page. Every message is recorded in sms_messages. Providers:
//   log     nothing leaves the server; the dashboard's SMS outbox shows
//           what the customer would receive (the default)
//   termii  Termii's SMS API (POST {base_url}/api/sms/send), the base URL
//           and sender ID from the Termii dashboard
//   brevo   Brevo's transactional SMS API (POST /v3/transactionalSMS/send),
//           with a sender ID registered with Brevo for Nigeria
// An admin sets the provider on the Settings page; API keys are stored
// encrypted like the Anthropic key. .env values are the fallback.
const { pool } = require('./db');
const { decrypt } = require('./secrets');

const KEYS = {
  provider: 'sms_provider', baseUrl: 'termii_base_url', apiKey: 'termii_api_key',
  senderId: 'termii_sender_id', channel: 'termii_channel', publicUrl: 'public_app_url', company: 'company_name',
  brevoKey: 'brevo_api_key', brevoSender: 'brevo_sender',
};

async function smsConfig(db = pool) {
  const { rows } = await db.query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [Object.values(KEYS)]);
  const by = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const env = process.env;
  const savedKey = decrypt(by[KEYS.apiKey]);
  const savedBrevo = decrypt(by[KEYS.brevoKey]);
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
    brevoApiKey: savedBrevo || env.BREVO_API_KEY || null,
    brevoKeySource: savedBrevo ? 'settings' : env.BREVO_API_KEY ? 'env' : 'none',
    brevoKeyUnreadable: !!by[KEYS.brevoKey] && !savedBrevo,
    brevoSender: by[KEYS.brevoSender] || env.BREVO_SENDER || '',
    brevoUrl: (env.BREVO_API_URL || 'https://api.brevo.com').replace(/\/$/, ''),
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

async function sendBrevo(cfg, to, body, reason) {
  if (!cfg.brevoApiKey || !cfg.brevoSender) {
    return { status: 'failed', error: 'Brevo is not fully set up: an API key and a sender are both needed' };
  }
  let res;
  try {
    res = await fetch(`${cfg.brevoUrl}/v3/transactionalSMS/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'api-key': cfg.brevoApiKey },
      // Country code and number, no plus: 2348031234567. Transactional
      // messages have no sending-hours limit at Brevo.
      body: JSON.stringify({ sender: cfg.brevoSender, recipient: to.replace(/^\+/, ''), content: body, type: 'transactional', tag: `tracking-${reason}` }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { status: 'failed', error: `Could not reach Brevo: ${err.message}` };
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.messageId != null) return { status: 'sent', providerMessageId: String(data.messageId) };
  return { status: 'failed', error: `Brevo ${res.status}: ${data.code ? `${data.code}, ` : ''}${data.message ?? JSON.stringify(data).slice(0, 200)}` };
}

/** Sends through the configured provider. */
function deliver(cfg, to, body, reason) {
  if (cfg.provider === 'termii') return sendTermii(cfg, to, body);
  if (cfg.provider === 'brevo') return sendBrevo(cfg, to, body, reason);
  return Promise.resolve({ status: 'logged' });
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
  const result = await deliver(cfg, o[0].customer_phone, body, reason);
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

// ---- Delivery results (Brevo) ---------------------------------------
//
// Brevo accepts a text at once and decides later: it can still reject it
// (no registered sender, no credits) or the network can fail to deliver.
// syncBrevoDelivery() asks Brevo's events API what happened to the texts
// it accepted in the last 48 hours and records the latest result. Results
// that cannot change again stop the checking.
const FINAL = new Set(['delivered', 'rejected', 'blocked', 'hardBounces', 'skipped', 'unsubscribed']);
// Readable names for the outbox; anything else is shown as Brevo sends it.
const DELIVERY_NAMES = { hardBounces: 'hard_bounce', softBounces: 'soft_bounce', replies: 'replied' };

async function syncBrevoDelivery() {
  const cfg = await smsConfig();
  if (!cfg.brevoApiKey) return { checked: 0, updated: 0 };
  const { rows: open } = await pool.query(
    `SELECT id, provider_message_id, created_at FROM sms_messages
     WHERE provider = 'brevo' AND status = 'sent' AND provider_message_id IS NOT NULL
       AND created_at > now() - interval '48 hours'
       AND (delivery_status IS NULL OR delivery_status NOT IN ('delivered', 'rejected', 'blocked', 'hard_bounce', 'skipped', 'unsubscribed'))`,
  );
  if (!open.length) return { checked: 0, updated: 0 };
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  const start = day(Math.min(...open.map((m) => new Date(m.created_at).getTime())));
  const end = day(Date.now());
  // Brevo pages events; 300 per check is plenty for a courier's day.
  const events = [];
  for (let offset = 0; offset < 300; offset += 100) {
    const res = await fetch(
      `${cfg.brevoUrl}/v3/transactionalSMS/statistics/events?limit=100&offset=${offset}&sort=desc&startDate=${start}&endDate=${end}`,
      { headers: { 'api-key': cfg.brevoApiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Brevo ${res.status}: ${data.code ?? ''} ${data.message ?? ''}`.trim());
    events.push(...(data.events ?? []));
    if ((data.events ?? []).length < 100) break;
  }
  // The latest event per message wins, but a final one is never replaced.
  const latest = new Map();
  for (const e of events) {
    const id = String(e.messageId);
    const prev = latest.get(id);
    const later = !prev || new Date(e.date) > new Date(prev.date);
    let take;
    if (!prev) take = true;
    else if (FINAL.has(prev.event)) take = FINAL.has(e.event) && later; // a final result only gives way to a later final one
    else take = FINAL.has(e.event) || later;
    if (take) latest.set(id, e);
  }
  let updated = 0;
  for (const m of open) {
    const e = latest.get(String(m.provider_message_id));
    if (!e) {
      await pool.query('UPDATE sms_messages SET delivery_checked_at = now() WHERE id = $1', [m.id]);
      continue;
    }
    const status = DELIVERY_NAMES[e.event] ?? e.event;
    const { rowCount } = await pool.query(
      `UPDATE sms_messages SET delivery_status = $2, delivery_at = $3, delivery_checked_at = now()
       WHERE id = $1 AND delivery_status IS DISTINCT FROM $2`,
      [m.id, status, e.date],
    );
    if (!rowCount) await pool.query('UPDATE sms_messages SET delivery_checked_at = now() WHERE id = $1', [m.id]);
    updated += rowCount;
  }
  return { checked: open.length, updated };
}

// Every 2 minutes while api-node runs. Failures (Brevo down, key removed)
// are logged and retried next time; they never affect the rest of the app.
function startDeliverySync(intervalMs = 120_000, onUpdate = () => {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await syncBrevoDelivery();
      if (r.updated) onUpdate(r);
    } catch (err) {
      console.warn(`SMS delivery check failed: ${err.message}`);
    } finally {
      running = false;
    }
  };
  const t = setInterval(tick, intervalMs);
  t.unref();
  setTimeout(tick, 5_000).unref();
  return () => clearInterval(t);
}

module.exports = {
  smsConfig, sendOrderSms, notifyLater, trackingUrl, deliver, SMS_KEYS: KEYS, sendTermii, sendBrevo,
  syncBrevoDelivery, startDeliverySync,
};
