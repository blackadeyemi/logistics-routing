// Shows Brevo's delivery events for recent SMS, to find out why a text
// did not arrive (accepted, sent, delivered, rejected, blocked...). Uses the
// Brevo key saved on the Settings page without printing it.
//   docker compose exec api-node node scripts/brevo-sms-events.js [days]
require('dotenv').config();
const { pool } = require('../src/db');
const { smsConfig } = require('../src/sms');

(async () => {
  const cfg = await smsConfig();
  if (!cfg.brevoApiKey) throw new Error('No Brevo API key saved');
  // Brevo returned nothing for days=N, so the range is given as dates.
  const days = Number(process.argv[2] || 2);
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86400_000);
  const d = (x) => x.toISOString().slice(0, 10);
  const url = `${cfg.brevoUrl}/v3/transactionalSMS/statistics/events?limit=50&sort=desc&startDate=${d(start)}&endDate=${d(end)}`;
  const res = await fetch(url, { headers: { 'api-key': cfg.brevoApiKey, Accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${data.code ?? ''} ${data.message ?? JSON.stringify(data)}`);
  const events = data.events ?? [];
  if (!events.length) console.log(`No SMS events at Brevo in the last ${days} day(s).`);
  for (const e of events) {
    // Mask the middle of the number in the output.
    const phone = String(e.phoneNumber ?? '').replace(/^(\+?\d{6})\d+(\d{2})$/, '$1…$2');
    console.log([e.date, e.event, phone, e.messageId, e.reason ?? '', e.tag ?? ''].join(' | '));
  }
  console.log(`sender in settings: ${cfg.brevoSender}`);
})()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => pool.end());
