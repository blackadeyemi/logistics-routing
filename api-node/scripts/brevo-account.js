// Read-only check of the saved Brevo key: whether Brevo accepts calls from
// this machine, and the plan and SMS credits. Sends nothing.
//   docker compose exec api-node node scripts/brevo-account.js
require('dotenv').config();
const { pool } = require('../src/db');
const { smsConfig } = require('../src/sms');

(async () => {
  const cfg = await smsConfig();
  if (!cfg.brevoApiKey) throw new Error('No Brevo API key saved');
  const res = await fetch(`${cfg.brevoUrl}/v3/account`, { headers: { 'api-key': cfg.brevoApiKey, Accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log(`Brevo ${res.status}: ${data.code ?? ''} ${data.message ?? ''}`);
    return;
  }
  console.log('Key accepted from this machine.');
  for (const p of data.plan ?? []) {
    console.log(`plan: type=${p.type} creditsType=${p.creditsType ?? ''} credits=${p.credits ?? ''}`);
  }
})()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => pool.end());
