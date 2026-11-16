'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault, memoryKeyStore, parseSecretKey, formatSecretKey } = require('../src/vault');
const totp = require('../src/totp');
const csv = require('../src/csv');
const { generatePassword } = require('../src/generator');
const strength = require('../renderer/strength');

const FAST = { name: 'scrypt', N: 2 ** 14, r: 8, p: 1 }; // keeps tests quick; the app uses 2^18
const MASTER = 'Correct-Horse-Battery-77';
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ezv-')), 'vault.ezv');
const mk = (p, ks = memoryKeyStore()) => new Vault(p, { keyStore: ks, kdf: FAST });

test('create, save, lock, unlock round trip; nothing readable on disk', async () => {
  const p = tmp(); const ks = memoryKeyStore();
  const v = mk(p, ks);
  const kit = await v.create(MASTER);
  assert.match(kit, /^EZ1(-[A-Z2-7]{4}){8}$/);
  const id = v.upsert({ title: 'Steam', username: 'mish', password: 'S3cret!pass', folder: 'Gaming' });
  v.lock();
  const raw = fs.readFileSync(p, 'utf8');
  for (const s of ['S3cret', 'Steam', 'mish', 'Gaming']) assert.ok(!raw.includes(s), s + ' leaked to disk');
  assert.ok(!raw.includes(kit.replace(/-/g, '').slice(3, 12)), 'secret key must not be in the vault file');
  const v2 = mk(p, ks);
  await v2.unlock(MASTER);
  assert.strictEqual(v2.get(id).password, 'S3cret!pass');
  assert.strictEqual(v2.list()[0].password, undefined);
  assert.strictEqual(v2.view(id).password, undefined, 'view() never contains the password');
});

test('weak master passwords are refused', async () => {
  await assert.rejects(mk(tmp()).create('short'), (e) => e.code === 'WEAK');
  await assert.rejects(mk(tmp()).create('password12345'), (e) => e.code === 'WEAK');
});

test('stolen vault file is useless without the Secret Key', async () => {
  const p = tmp();
  const v = mk(p);
  const kit = await v.create(MASTER);
  v.lock();
  const thief = mk(p, memoryKeyStore()); // a different PC: no key in its store
  assert.ok(thief.needsSecretKey());
  await assert.rejects(thief.unlock(MASTER), (e) => e.code === 'NEEDS_SECRET_KEY');
  const wrongKit = formatSecretKey(crypto.randomBytes(20));
  await assert.rejects(thief.unlock(MASTER, wrongKit), (e) => e.code === 'BAD_PASSWORD');
  // Rightful owner on a new PC: password + Emergency Kit (typed sloppily) works, and the key is remembered.
  const newPc = memoryKeyStore();
  const owner = mk(p, newPc);
  await owner.unlock(MASTER, kit.toLowerCase().replace(/-/g, ' '));
  owner.lock();
  assert.ok(!mk(p, newPc).needsSecretKey());
});

test('wrong password and header tampering are rejected', async () => {
  const p = tmp(); const ks = memoryKeyStore();
  const v = mk(p, ks);
  await v.create(MASTER);
  v.lock();
  await assert.rejects(mk(p, ks).unlock('nope nope nope'), (e) => e.code === 'BAD_PASSWORD');
  const f = JSON.parse(fs.readFileSync(p, 'utf8'));
  f.kdf.N = 2 ** 15; // tamper
  fs.writeFileSync(p, JSON.stringify(f));
  await assert.rejects(mk(p, ks).unlock(MASTER), (e) => e.code === 'BAD_PASSWORD');
  f.kdf.N = 2 ** 10; // downgrade below floor
  fs.writeFileSync(p, JSON.stringify(f));
  await assert.rejects(mk(p, ks).unlock(MASTER), (e) => e.code === 'CORRUPT');
});

test('KDF is upgraded automatically when defaults rise', async () => {
  const p = tmp(); const ks = memoryKeyStore();
  const v = mk(p, ks);
  await v.create(MASTER);
  v.lock();
  const stronger = new Vault(p, { keyStore: ks, kdf: { name: 'scrypt', N: 2 ** 15, r: 8, p: 1 } });
  await stronger.unlock(MASTER);
  stronger.lock();
  assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf8')).kdf.N, 2 ** 15);
  await mk(p, ks).unlock(MASTER);
});

test('history, verify, change master, settings weakening, audit', async () => {
  const p = tmp(); const ks = memoryKeyStore();
  const v = mk(p, ks);
  await v.create(MASTER);
  const a = v.upsert({ title: 'A', password: 'password123' });
  v.upsert({ title: 'B', password: 'Xy7#kQ2!mZ9$vL4@' });
  v.upsert({ title: 'C', password: 'Xy7#kQ2!mZ9$vL4@' });
  v.upsert({ type: 'apikey', title: 'OpenAI', password: 'sk-test' });
  v.upsert({ id: a, title: 'A', password: 'new-Password-9981!' });
  assert.strictEqual(v.get(a).history[0].password, 'password123');
  const audit = v.audit();
  assert.strictEqual(audit.reusedCount, 2);
  assert.strictEqual(audit.unprotectedKeys.length, 1);
  assert.ok(await v.verifyMaster(MASTER));
  assert.ok(!(await v.verifyMaster('wrong wrong wrong')));
  assert.ok(v.weakens(v.normalizeSettings({ streamerMode: false })));
  assert.ok(v.weakens(v.normalizeSettings({ autoLockMinutes: 0 })));
  assert.ok(!v.weakens(v.normalizeSettings({ autoLockMinutes: 2 })));
  await assert.rejects(v.changeMaster('wrong wrong', 'Brand-New-Master-55!'), (e) => e.code === 'BAD_PASSWORD');
  await v.changeMaster(MASTER, 'Brand-New-Master-55!');
  v.lock();
  await assert.rejects(mk(p, ks).unlock(MASTER), (e) => e.code === 'BAD_PASSWORD');
  await mk(p, ks).unlock('Brand-New-Master-55!');
  assert.ok(fs.existsSync(p + '.bak'));
});

test('secret key parsing tolerates typos of look-alike characters', () => {
  const k = crypto.randomBytes(20);
  const t = formatSecretKey(k);
  assert.deepStrictEqual(parseSecretKey(t), k);
  assert.deepStrictEqual(parseSecretKey(t.replace(/O/g, '0').replace(/I/g, '1')), k);
  assert.throws(() => parseSecretKey('EZ1-ABCD'), (e) => e.code === 'BAD_SECRET_KEY');
});

test('TOTP matches RFC 6238 vectors', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.strictEqual(totp.generate(secret, 59000).code, '287082');
  assert.strictEqual(totp.generate(secret, 1111111109000).code, '081804');
  assert.strictEqual(totp.generate(`otpauth://totp/Test?secret=${secret}&digits=8`, 59000).code, '94287082');
  assert.ok(!totp.isValid('not base32 !!'));
});

test('CSV import (Chrome + Bitwarden) and export', () => {
  const e = csv.toEntries('﻿name,url,username,password,note\r\nDiscord,https://discord.com,mish,"pa,ss""word",hi\r\n');
  assert.strictEqual(e[0].password, 'pa,ss"word');
  const b = csv.toEntries('folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\nGaming,,login,FACEIT,,,,https://faceit.com,mish,pw1,\n');
  assert.strictEqual(b[0].title, 'FACEIT');
  assert.strictEqual(csv.toEntries(csv.fromEntries(e))[0].password, 'pa,ss"word');
});

test('generator and strength', () => {
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword({ length: 16 }).value;
    assert.ok(pw.length === 16 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw));
  }
  assert.ok(!/[O0oIl1]/.test(generatePassword({ length: 128, avoidAmbiguous: true }).value));
  assert.strictEqual(strength.estimate('P4ssw0rd').score, 0);
  assert.ok(strength.estimate(generatePassword({ length: 20 }).value).score >= 3);
});

test('real-strength KDF runs within a usable time', async () => {
  const p = tmp();
  const v = new Vault(p);
  const t = Date.now();
  await v.create(MASTER);
  assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf8')).kdf.N, 2 ** 18);
  assert.ok(Date.now() - t < 10000);
});

// ---------------------------------------------------------------- v1.2 features
const backups = require('../src/backups');
const { generate, generatePassphrase, WORD_COUNT } = require('../src/generator');

test('Steam Guard codes match the reference algorithm (node-steam-totp)', () => {
  const shared = 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=';
  // Reference implementation, ported line-for-line from node-steam-totp generateAuthCode()
  const ref = (secret, timeSec) => {
    const buf = Buffer.alloc(8); buf.writeUInt32BE(0, 0); buf.writeUInt32BE(Math.floor(timeSec / 30), 4);
    let h = crypto.createHmac('sha1', Buffer.from(secret, 'base64')).update(buf).digest();
    const start = h[19] & 0x0F; h = h.slice(start, start + 4);
    let full = h.readUInt32BE(0) & 0x7FFFFFFF; const chars = '23456789BCDFGHJKMNPQRTVWXY'; let code = '';
    for (let i = 0; i < 5; i++) { code += chars.charAt(full % chars.length); full /= chars.length; }
    return code;
  };
  const stored = totp.normalizeSteam(shared);
  assert.match(stored, /^steam:\/\/[A-Z2-7]+$/);
  for (const t of [0, 59, 1700000000, 1763300000, 2000000123]) {
    const g = totp.generate(stored, t * 1000);
    assert.strictEqual(g.code, ref(shared, t));
    assert.ok(g.steam && g.code.length === 5);
  }
  assert.strictEqual(totp.normalizeSteam(JSON.stringify({ shared_secret: shared, account_name: 'x' })), stored);
  assert.strictEqual(totp.normalizeSteam(stored), stored);
  assert.throws(() => totp.normalizeSteam('{"nope":1}'));
});

test('passphrase generator', () => {
  assert.ok(WORD_COUNT > 3900);
  const p = generatePassphrase({ words: 6, separator: '-', capitalize: true, number: true });
  const parts = p.value.split('-');
  assert.strictEqual(parts.length, 6);
  assert.ok(parts.every((w) => /^[A-Z][a-z]+\d?$/.test(w)));
  assert.strictEqual(parts.filter((w) => /\d$/.test(w)).length, 1);
  assert.ok(p.bits >= 72);
  assert.strictEqual(generate({ mode: 'passphrase', words: 4, separator: ' ', capitalize: false, number: false }).value.split(' ').length, 4);
  assert.strictEqual(generate({ length: 30 }).value.length, 30);
});

test('trash: soft delete, restore, purge, expiry', async () => {
  const p = tmp();
  const v = mk(p);
  await v.create(MASTER);
  const a = v.upsert({ title: 'A', password: 'x1' });
  const b = v.upsert({ title: 'B', password: 'x2' });
  v.remove(a);
  assert.deepStrictEqual(v.list().map((e) => e.id), [b]);
  assert.strictEqual(v.trash()[0].id, a);
  assert.throws(() => v.upsert({ id: a, title: 'A2' }), (e) => e.code === 'IN_TRASH');
  v.restore(a);
  assert.strictEqual(v.list().length, 2);
  v.remove(a); v.purge(a);
  assert.strictEqual(v.trash().length, 0);
  assert.throws(() => v.get(a));
  v.remove(b);
  assert.strictEqual(v.purgeExpired(Date.now() + 31 * 864e5), 1);
  assert.strictEqual(v.exportAll().length, 0);
});

test('automatic backups: hourly snapshots, retention, mirror folder', async () => {
  const p = tmp();
  const dir = path.join(path.dirname(p), 'backups');
  const usb = path.join(path.dirname(p), 'usb');
  const v = new Vault(p, { kdf: FAST, onSaved: (file, s) => backups.snapshot(file, [dir, s.backupDir], s.backupKeepDays) });
  await v.create(MASTER);
  v.applySettings(v.normalizeSettings({ backupDir: usb }));
  v.upsert({ title: 'A', password: 'x' });
  assert.strictEqual(backups.list(dir).length, 1, 'one snapshot per hour');
  assert.strictEqual(backups.list(usb).length, 1);
  // Retention: fake 40 days of hourly-ish files
  const now = new Date(2026, 10, 16, 12);
  for (let h = 40 * 24; h >= 0; h -= 6) backups.snapshot(p, [dir], 30, new Date(now.getTime() - h * 3600e3));
  const kept = backups.list(dir).filter((x) => x.date < new Date(2026, 10, 14).toISOString());
  const days = new Set(kept.map((x) => x.date.slice(0, 10)));
  assert.strictEqual(kept.length, days.size, 'older than 48h: one per day');
  assert.ok(backups.list(dir).every((x) => Date.parse(x.date) > now.getTime() - 31 * 864e5));
  // A backup opens with the same password + Secret Key
  const snap = backups.list(dir)[0].path;
  const copy = new Vault(snap, { keyStore: v.keyStore, kdf: FAST });
  await copy.unlock(MASTER);
});

test('backup list recognizes pre-reset copies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezb-'));
  const f = path.join(dir, 'v.ezv'); fs.writeFileSync(f, '{}');
  const out = backups.preRestoreCopy(f, dir, new Date(), 'pre-reset');
  const l = backups.list(dir);
  assert.strictEqual(l.length, 1);
  assert.strictEqual(l[0].kind, 'pre-reset');
  assert.strictEqual(l[0].path, out);
  backups.prune(dir, 30);
  assert.strictEqual(backups.list(dir).length, 1, 'safety copies are not pruned early');
});
