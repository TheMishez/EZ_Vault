'use strict';
// 2FA codes: RFC 6238 TOTP (Google Authenticator style) and Steam Guard (5-character codes).
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEAM_CHARS = '23456789BCDFGHJKMNPQRTVWXY';

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid 2FA secret (must be base32)');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (out.length === 0) throw new Error('2FA secret is empty');
  return Buffer.from(out);
}

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Converts what a user pastes for Steam Guard into the stored form "steam://BASE32".
 * Accepts: the base64 shared_secret, a whole Steam Desktop Authenticator .maFile (JSON),
 * or an existing steam:// value.
 */
function normalizeSteam(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Paste your Steam shared_secret');
  if (/^steam:\/\//i.test(raw)) {
    const b32 = raw.slice(8).replace(/[\s=]/g, '').toUpperCase();
    base32Decode(b32);
    return 'steam://' + b32;
  }
  let secret = raw;
  if (raw.startsWith('{')) {
    let json;
    try { json = JSON.parse(raw); } catch { throw new Error('That .maFile text is not valid JSON'); }
    secret = json.shared_secret;
    if (!secret) throw new Error('No shared_secret found in that .maFile');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error('Steam shared_secret should be base64 (like "abc123…=")');
  const key = Buffer.from(secret, 'base64');
  if (key.length < 10) throw new Error('That Steam shared_secret is too short');
  return 'steam://' + base32Encode(key);
}

/** Accepts a bare base32 secret, an otpauth://totp/... URI, or steam://BASE32. */
function parse(secretOrUri) {
  const raw = String(secretOrUri || '').trim();
  const cfg = { secret: raw, digits: 6, period: 30, algorithm: 'sha1', steam: false };
  if (/^steam:\/\//i.test(raw)) {
    cfg.steam = true;
    cfg.digits = 5;
    cfg.secret = raw.slice(8);
  } else if (/^otpauth:\/\//i.test(raw)) {
    const url = new URL(raw);
    const host = url.host.toLowerCase();
    if (host !== 'totp') throw new Error('Only TOTP (time-based) codes are supported');
    cfg.secret = url.searchParams.get('secret') || '';
    const d = parseInt(url.searchParams.get('digits'), 10);
    const p = parseInt(url.searchParams.get('period'), 10);
    const a = (url.searchParams.get('algorithm') || 'SHA1').toLowerCase();
    if ([6, 7, 8].includes(d)) cfg.digits = d;
    if (p >= 10 && p <= 300) cfg.period = p;
    if (['sha1', 'sha256', 'sha512'].includes(a)) cfg.algorithm = a;
    if ((url.searchParams.get('encoder') || '').toLowerCase() === 'steam') { cfg.steam = true; cfg.digits = 5; }
  }
  cfg.key = base32Decode(cfg.secret);
  return cfg;
}

function generate(secretOrUri, nowMs = Date.now()) {
  const cfg = parse(secretOrUri);
  const seconds = Math.floor(nowMs / 1000);
  const counter = Math.floor(seconds / cfg.period);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac(cfg.algorithm, cfg.key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  let bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  let code;
  if (cfg.steam) {
    code = '';
    for (let i = 0; i < 5; i++) { code += STEAM_CHARS[bin % STEAM_CHARS.length]; bin = Math.floor(bin / STEAM_CHARS.length); }
  } else {
    code = String(bin % 10 ** cfg.digits).padStart(cfg.digits, '0');
  }
  return { code, period: cfg.period, remaining: cfg.period - (seconds % cfg.period), steam: cfg.steam };
}

function isValid(secretOrUri) {
  try { parse(secretOrUri); return true; } catch { return false; }
}

const isSteam = (v) => /^steam:\/\//i.test(String(v || '').trim());

module.exports = { generate, isValid, isSteam, normalizeSteam, base32Decode, base32Encode };
