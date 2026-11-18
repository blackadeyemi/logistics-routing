// Encryption for secrets an admin saves in app_settings, such as the
// Anthropic API key. AES-256-GCM with a key from SETTINGS_ENCRYPTION_KEY
// (32 random bytes, base64 or hex). A database dump alone does not reveal
// the secret; the .env key is needed too.
const crypto = require('node:crypto');
const { HttpError } = require('./errors');

const PREFIX = 'enc:v1:';

function key() {
  const raw = (process.env.SETTINGS_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('SETTINGS_ENCRYPTION_KEY must be 32 bytes, base64 or hex');
  return buf;
}

function canEncrypt() {
  try {
    return key() !== null;
  } catch {
    return false;
  }
}

function encrypt(plain) {
  const k = key();
  if (!k) throw new HttpError(409, 'Saving secrets needs SETTINGS_ENCRYPTION_KEY in .env. Generate one with: openssl rand -base64 32');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

// Returns null when the value cannot be read (key missing or changed), so
// callers treat it as "not set" instead of failing every request.
function decrypt(stored) {
  if (!stored || !stored.startsWith(PREFIX)) return null;
  try {
    const k = key();
    if (!k) return null;
    const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// "sk-ant-api03-…AbCd": enough to tell keys apart, useless to an attacker.
function hint(secret) {
  if (!secret) return null;
  return `${secret.slice(0, 7)}…${secret.slice(-4)}`;
}

module.exports = { encrypt, decrypt, hint, canEncrypt };
