'use strict';
/*
 * EZ Vault storage engine — format v2.
 *
 * Two secrets protect every vault:
 *   1. Your master password (only in your head).
 *   2. A 160-bit random Secret Key, made when the vault is created. It is kept on this PC
 *      under Windows DPAPI and printed on your Emergency Kit. It is never in the vault file.
 *
 * Key hierarchy:
 *   stretched = scrypt(masterPassword, salt, N=2^18, r=8, p=1)        (~256 MB, memory-hard)
 *   KEK       = HKDF-SHA256(stretched || secretKey, salt, "EZVault v2 KEK")
 *   DEK       = 32 random bytes, wrapped with AES-256-GCM under the KEK
 *   data      = AES-256-GCM(DEK, fresh 96-bit IV per save)
 *
 * The header (format, version, keyId, kdf) is bound as AAD to both the wrapped key and the data,
 * so changing any of it (a KDF downgrade, for example) makes the vault refuse to open.
 * A stolen vault file can't be brute-forced: the attacker would also need the 160-bit Secret Key.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const strength = require('../renderer/strength');
const { base32Decode, base32Encode } = require('./totp');

const FORMAT = 'ezvault';
const VERSION = 2;
const CURRENT_KDF = Object.freeze({ name: 'scrypt', N: 2 ** 18, r: 8, p: 1 });
const MAX_HISTORY = 10;
const SECRET_BYTES = 20;
const LIMITS = { title: 200, username: 500, password: 4000, url: 2000, notes: 20000, totp: 1000, folder: 60 };
const TYPES = ['login', 'note', 'apikey'];

const DEFAULT_SETTINGS = {
  autoLockMinutes: 5,
  clipboardSeconds: 15,
  lockOnMinimize: false,
  streamerMode: true,
  backupDir: '',
  backupKeepDays: 30,
  generator: {
    mode: 'password', length: 24, upper: true, lower: true, digits: true, symbols: true, avoidAmbiguous: false,
    words: 6, separator: '-', capitalize: true, number: true
  }
};
const TRASH_DAYS = 30;
const DEFAULT_FOLDERS = ['Gaming', 'Socials', 'Email', 'Finance', 'Work', 'API Keys'];

class VaultError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

// ---------- Secret Key text format: EZ1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX ----------
function formatSecretKey(buf) {
  return 'EZ1-' + base32Encode(buf).match(/.{1,4}/g).join('-');
}
function parseSecretKey(text) {
  let s = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('EZ1')) s = s.slice(3);
  s = s.replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');
  if (s.length !== 32) throw new VaultError('BAD_SECRET_KEY', 'That Secret Key is not the right length — check your Emergency Kit');
  const buf = base32Decode(s);
  if (buf.length !== SECRET_BYTES) throw new VaultError('BAD_SECRET_KEY', 'That Secret Key is not valid');
  return buf;
}

// ---------- crypto primitives ----------
function scrypt(password, kdf) {
  const pw = Buffer.from(String(password).normalize('NFKC'), 'utf8');
  const salt = Buffer.from(kdf.salt, 'base64');
  const maxmem = 128 * kdf.N * kdf.r * kdf.p + 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    crypto.scrypt(pw, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem }, (err, key) => {
      pw.fill(0);
      err ? reject(err) : resolve(key);
    });
  });
}

async function deriveKEK(password, kdf, secret) {
  const stretched = await scrypt(password, kdf);
  const ikm = Buffer.concat([stretched, secret || Buffer.alloc(0)]);
  const kek = Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.from(kdf.salt, 'base64'), Buffer.from('EZVault v2 KEK'), 32));
  stretched.fill(0); ikm.fill(0);
  return kek;
}

function headerOf(keyId, kdf) {
  return { format: FORMAT, version: VERSION, keyId, kdf: { name: kdf.name, N: kdf.N, r: kdf.r, p: kdf.p, salt: kdf.salt } };
}
const aadOf = (header) => Buffer.from(JSON.stringify(header));

function seal(key, plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}
function open(key, box, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAAD(aad);
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(box.ct, 'base64')), d.final()]);
}

// Legacy v1 (single scrypt key, no Secret Key) — read-only, upgraded on first unlock.
async function openV1(file, master) {
  const key = await scrypt(master, file.kdf);
  const header = { format: FORMAT, version: 1, kdf: { name: file.kdf.name, N: file.kdf.N, r: file.kdf.r, p: file.kdf.p, salt: file.kdf.salt } };
  try {
    return JSON.parse(open(key, { iv: file.iv, tag: file.tag, ct: file.data }, aadOf(header)).toString('utf8'));
  } catch { throw new VaultError('BAD_PASSWORD', 'Wrong master password'); }
  finally { key.fill(0); }
}

function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }

/** In-memory key store, used by tests. The app uses a Windows DPAPI-backed store (see main.js). */
function memoryKeyStore() {
  const m = new Map();
  return { get: (id) => (m.has(id) ? Buffer.from(m.get(id)) : null), set: (id, buf) => m.set(id, Buffer.from(buf)), remove: (id) => m.delete(id) };
}

class Vault {
  constructor(filePath, { keyStore = memoryKeyStore(), kdf = CURRENT_KDF, onSaved = null } = {}) {
    this.filePath = filePath;
    this.onSaved = onSaved;
    this.keyStore = keyStore;
    this.targetKdf = kdf;
    this.dek = null;
    this.kdf = null;
    this.keyId = null;
    this.data = null;
  }

  exists() { return fs.existsSync(this.filePath); }
  get unlocked() { return !!this.data; }
  _require() { if (!this.data) throw new VaultError('LOCKED', 'Vault is locked'); }

  _readFile() {
    let file;
    try { file = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); }
    catch { throw new VaultError('CORRUPT', 'Vault file could not be read'); }
    if (file.format !== FORMAT || !file.kdf || file.kdf.name !== 'scrypt') throw new VaultError('CORRUPT', 'Not an EZ Vault file');
    if (file.version > VERSION) throw new VaultError('NEWER', 'This vault was made by a newer version of EZ Vault');
    if (file.kdf.N < 2 ** 14 || file.kdf.r < 8) throw new VaultError('CORRUPT', 'Vault key settings are below the safe minimum');
    return file;
  }

  /** Whether this PC holds the Secret Key for the vault on disk. */
  needsSecretKey() {
    if (!this.exists()) return false;
    try {
      const f = this._readFile();
      return f.version >= 2 && !this.keyStore.get(f.keyId);
    } catch { return false; }
  }

  _newKdf() { return { ...this.targetKdf, salt: crypto.randomBytes(32).toString('base64') }; }

  /** Creates a vault. Returns the Secret Key text for the Emergency Kit. */
  async create(master) {
    if (this.exists()) throw new VaultError('EXISTS', 'A vault already exists');
    Vault.assertMasterStrength(master);
    const secret = crypto.randomBytes(SECRET_BYTES);
    this.keyId = crypto.randomBytes(8).toString('hex');
    this.kdf = this._newKdf();
    this.dek = crypto.randomBytes(32);
    this._wrapWith(await deriveKEK(master, this.kdf, secret));
    this.keyStore.set(this.keyId, secret);
    const now = new Date().toISOString();
    this.data = { created: now, entries: [], folders: [...DEFAULT_FOLDERS], settings: structuredClone(DEFAULT_SETTINGS) };
    this.save();
    const text = formatSecretKey(secret);
    secret.fill(0);
    return text;
  }

  static assertMasterStrength(master) {
    if (typeof master !== 'string' || [...master].length < 12) throw new VaultError('WEAK', 'Master password must be at least 12 characters');
    if (strength.estimate(master).score < 3) throw new VaultError('WEAK', 'Master password is too easy to guess — use a longer phrase');
  }

  /**
   * Unlocks the vault. secretKeyText is only needed on a PC that doesn't hold the Secret Key yet.
   * Returns { newSecretKey } if an old v1 vault was upgraded and a Secret Key was just created.
   */
  async unlock(master, secretKeyText) {
    const file = this._readFile();
    if (file.version === 1) return this._migrateV1(file, master);

    let secret = secretKeyText ? parseSecretKey(secretKeyText) : this.keyStore.get(file.keyId);
    if (!secret) throw new VaultError('NEEDS_SECRET_KEY', 'This PC needs your Secret Key from your Emergency Kit');
    const header = headerOf(file.keyId, file.kdf);
    const kek = await deriveKEK(master, file.kdf, secret);
    let dek;
    try { dek = open(kek, file.wrap, aadOf(header)); }
    catch {
      kek.fill(0);
      throw new VaultError('BAD_PASSWORD', secretKeyText ? 'Wrong master password or Secret Key' : 'Wrong master password');
    }
    let data;
    try { data = JSON.parse(open(dek, file.box, aadOf(header)).toString('utf8')); }
    catch { kek.fill(0); dek.fill(0); throw new VaultError('CORRUPT', 'Vault data failed its integrity check'); }

    if (secretKeyText) this.keyStore.set(file.keyId, secret);
    secret.fill(0);
    this.keyId = file.keyId;
    this.kdf = { ...file.kdf };
    this.dek = dek;
    this.wrap = file.wrap;
    kek.fill(0);
    this._load(data);
    if (this.purgeExpired()) this.save();

    // Transparently upgrade key-stretching strength when defaults go up.
    if (file.kdf.N < this.targetKdf.N || file.kdf.r < this.targetKdf.r) {
      await this._rewrap(master);
    }
    return {};
  }

  async _migrateV1(file, master) {
    const data = await openV1(file, master);
    const secret = crypto.randomBytes(SECRET_BYTES);
    this.keyId = crypto.randomBytes(8).toString('hex');
    this.kdf = this._newKdf();
    this.dek = crypto.randomBytes(32);
    this._wrapWith(await deriveKEK(master, this.kdf, secret));
    this.keyStore.set(this.keyId, secret);
    this._load(data);
    this.save();
    const text = formatSecretKey(secret);
    secret.fill(0);
    return { newSecretKey: text };
  }

  _load(data) {
    data.entries = Array.isArray(data.entries) ? data.entries : [];
    data.folders = Array.isArray(data.folders) ? data.folders : [...DEFAULT_FOLDERS];
    data.settings = { ...structuredClone(DEFAULT_SETTINGS), ...(data.settings || {}) };
    data.settings.generator = { ...DEFAULT_SETTINGS.generator, ...(data.settings.generator || {}) };
    this.data = data;
  }

  async _rewrap(master) {
    const secret = this.keyStore.get(this.keyId);
    if (!secret) throw new VaultError('NEEDS_SECRET_KEY', 'Secret Key missing on this PC');
    const kdf = this._newKdf();
    const kek = await deriveKEK(master, kdf, secret);
    secret.fill(0);
    this.kdf = kdf;
    this._wrapWith(kek);
    this.save();
  }

  /** Wraps the vault key under a KEK (then wipes the KEK — it is never kept in memory). */
  _wrapWith(kek) {
    this.wrap = seal(kek, this.dek, aadOf(headerOf(this.keyId, this.kdf)));
    kek.fill(0);
  }

  lock() {
    if (this.dek) this.dek.fill(0);
    this.dek = null;
    this.wrap = null;
    this.data = null;
  }

  save() {
    this._require();
    const header = headerOf(this.keyId, this.kdf);
    const aad = aadOf(header);
    const file = { ...header, cipher: 'aes-256-gcm', wrap: this.wrap, box: seal(this.dek, Buffer.from(JSON.stringify(this.data), 'utf8'), aad) };
    const out = JSON.stringify(file);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, out); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (fs.existsSync(this.filePath)) fs.copyFileSync(this.filePath, this.filePath + '.bak');
    fs.renameSync(tmp, this.filePath);
    if (this.onSaved) { try { this.onSaved(this.filePath, this.data.settings); } catch { /* backups never block saving */ } }
  }

  /** Re-derives the key from the password (and this PC's Secret Key) and checks it can unwrap the vault key. */
  async verifyMaster(master) {
    this._require();
    const secret = this.keyStore.get(this.keyId);
    if (!secret) return false;
    const kek = await deriveKEK(master, this.kdf, secret);
    secret.fill(0);
    let ok = false;
    try {
      const dek = open(kek, this.wrap, aadOf(headerOf(this.keyId, this.kdf)));
      ok = crypto.timingSafeEqual(dek, this.dek);
      dek.fill(0);
    } catch { ok = false; }
    kek.fill(0);
    return ok;
  }

  async changeMaster(oldPw, newPw) {
    this._require();
    if (!(await this.verifyMaster(oldPw))) throw new VaultError('BAD_PASSWORD', 'Current master password is wrong');
    Vault.assertMasterStrength(newPw);
    await this._rewrap(newPw);
  }

  /** Returns the Secret Key text (caller must re-verify the master password first). */
  secretKeyText() {
    this._require();
    const s = this.keyStore.get(this.keyId);
    if (!s) throw new VaultError('NEEDS_SECRET_KEY', 'Secret Key missing on this PC');
    const t = formatSecretKey(s);
    s.fill(0);
    return t;
  }

  // ----- entries -----

  _live() { return this.data.entries.filter((e) => !e.deletedAt); }

  list() {
    this._require();
    return this._live().map((e) => ({
      id: e.id, type: e.type, title: e.title, username: e.username, url: e.url,
      folder: e.folder, favorite: !!e.favorite, reprompt: !!e.reprompt, hasTotp: !!e.totp, hasPassword: !!e.password,
      created: e.created, updated: e.updated
    }));
  }

  trash() {
    this._require();
    return this.data.entries.filter((e) => e.deletedAt).map((e) => ({
      id: e.id, type: e.type, title: e.title, username: e.username, url: e.url, folder: e.folder,
      favorite: false, reprompt: !!e.reprompt, hasTotp: !!e.totp, hasPassword: !!e.password, deletedAt: e.deletedAt
    })).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  get(id) {
    this._require();
    const e = this.data.entries.find((x) => x.id === id);
    if (!e) throw new VaultError('NOT_FOUND', 'Item not found');
    return structuredClone(e);
  }

  /** Safe-to-display view: no password, no 2FA secret, no old passwords. */
  view(id, { includeNotes = true } = {}) {
    const e = this.get(id);
    return {
      id: e.id, type: e.type, title: e.title, username: e.username, url: e.url, folder: e.folder,
      favorite: !!e.favorite, reprompt: !!e.reprompt, notes: includeNotes ? e.notes : '', hasNotes: !!e.notes,
      hasPassword: !!e.password, hasTotp: !!e.totp, totpKind: /^steam:\/\//i.test(e.totp || '') ? 'steam' : 'totp',
      deletedAt: e.deletedAt || null, passwordScore: e.password ? strength.estimate(e.password) : null,
      history: (e.history || []).map((h) => ({ changed: h.changed })),
      created: e.created, updated: e.updated, passwordChanged: e.passwordChanged
    };
  }

  _sanitize(input) {
    return {
      type: TYPES.includes(input.type) ? input.type : 'login',
      title: str(input.title, LIMITS.title).trim() || 'Untitled',
      username: str(input.username, LIMITS.username),
      password: str(input.password, LIMITS.password),
      url: str(input.url, LIMITS.url).trim(),
      notes: str(input.notes, LIMITS.notes),
      totp: str(input.totp, LIMITS.totp).trim(),
      folder: str(input.folder, LIMITS.folder).trim(),
      favorite: !!input.favorite,
      reprompt: !!input.reprompt
    };
  }

  upsert(input, { persist = true } = {}) {
    this._require();
    const clean = this._sanitize(input || {});
    const now = new Date().toISOString();
    let entry = input && input.id ? this.data.entries.find((x) => x.id === input.id) : null;
    if (input && input.id && !entry) throw new VaultError('NOT_FOUND', 'Item not found');
    if (entry && entry.deletedAt) throw new VaultError('IN_TRASH', 'Restore this item from the trash before editing it');
    if (entry) {
      if (entry.password && entry.password !== clean.password) {
        entry.history = [{ password: entry.password, changed: now }, ...(entry.history || [])].slice(0, MAX_HISTORY);
        entry.passwordChanged = now;
      }
      Object.assign(entry, clean, { updated: now });
    } else {
      entry = { id: crypto.randomUUID(), ...clean, created: now, updated: now, passwordChanged: now, history: [] };
      this.data.entries.push(entry);
    }
    if (clean.folder && !this.data.folders.includes(clean.folder)) this.data.folders.push(clean.folder);
    if (persist) this.save();
    return entry.id;
  }

  /** Moves an item to the trash (kept for 30 days). */
  remove(id) {
    this._require();
    const e = this.data.entries.find((x) => x.id === id);
    if (!e) throw new VaultError('NOT_FOUND', 'Item not found');
    e.deletedAt = new Date().toISOString();
    this.save();
  }

  restore(id) {
    this._require();
    const e = this.data.entries.find((x) => x.id === id);
    if (!e) throw new VaultError('NOT_FOUND', 'Item not found');
    delete e.deletedAt;
    if (e.folder && !this.data.folders.includes(e.folder)) this.data.folders.push(e.folder);
    this.save();
  }

  /** Permanently deletes one trashed item. */
  purge(id) {
    this._require();
    const e = this.data.entries.find((x) => x.id === id);
    if (!e) throw new VaultError('NOT_FOUND', 'Item not found');
    if (!e.deletedAt) throw new VaultError('NOT_IN_TRASH', 'Move the item to the trash first');
    this.data.entries = this.data.entries.filter((x) => x.id !== id);
    this.save();
  }

  emptyTrash() {
    this._require();
    const before = this.data.entries.length;
    this.data.entries = this._live();
    this.save();
    return before - this.data.entries.length;
  }

  purgeExpired(now = Date.now()) {
    const cutoff = now - TRASH_DAYS * 24 * 3600 * 1000;
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter((e) => !e.deletedAt || Date.parse(e.deletedAt) > cutoff);
    return before - this.data.entries.length;
  }

  importMany(entries) {
    this._require();
    let n = 0;
    for (const e of entries) { this.upsert({ ...e, id: undefined }, { persist: false }); n++; }
    this.save();
    return n;
  }

  exportAll() { this._require(); return structuredClone(this._live()); }

  // ----- folders & settings -----

  folders() { this._require(); return [...this.data.folders]; }

  addFolder(name) {
    this._require();
    const n = str(name, LIMITS.folder).trim();
    if (n && !this.data.folders.includes(n)) { this.data.folders.push(n); this.save(); }
    return this.folders();
  }

  removeFolder(name) {
    this._require();
    this.data.folders = this.data.folders.filter((f) => f !== name);
    for (const e of this.data.entries) if (e.folder === name) e.folder = '';
    this.save();
    return this.folders();
  }

  getSettings() { this._require(); return structuredClone(this.data.settings); }

  /** Normalizes a settings patch without applying it. */
  normalizeSettings(patch) {
    const s = structuredClone(this.data.settings);
    const p = patch || {};
    const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
    if ('autoLockMinutes' in p) s.autoLockMinutes = clampInt(p.autoLockMinutes, 0, 240, s.autoLockMinutes);
    if ('clipboardSeconds' in p) s.clipboardSeconds = clampInt(p.clipboardSeconds, 0, 600, s.clipboardSeconds);
    if ('lockOnMinimize' in p) s.lockOnMinimize = !!p.lockOnMinimize;
    if ('streamerMode' in p) s.streamerMode = !!p.streamerMode;
    if ('backupDir' in p) s.backupDir = typeof p.backupDir === 'string' ? p.backupDir.slice(0, 1000) : '';
    if ('backupKeepDays' in p) s.backupKeepDays = clampInt(p.backupKeepDays, 3, 365, s.backupKeepDays);
    if (p.generator) {
      const g = s.generator;
      for (const k of ['upper', 'lower', 'digits', 'symbols', 'avoidAmbiguous', 'capitalize', 'number']) if (k in p.generator) g[k] = !!p.generator[k];
      if ('length' in p.generator) g.length = clampInt(p.generator.length, 8, 128, g.length);
      if ('words' in p.generator) g.words = clampInt(p.generator.words, 3, 12, g.words);
      if ('mode' in p.generator) g.mode = p.generator.mode === 'passphrase' ? 'passphrase' : 'password';
      if ('separator' in p.generator && ['-', '.', '_', ' ', ',', ''].includes(p.generator.separator)) g.separator = p.generator.separator;
    }
    return s;
  }

  /** True if moving from current settings to `next` lowers protection. */
  weakens(next) {
    const cur = this.data.settings;
    const lockLonger = (a, b) => (a === 0 ? Infinity : a) > (b === 0 ? Infinity : b);
    return (cur.streamerMode && !next.streamerMode)
      || (cur.lockOnMinimize && !next.lockOnMinimize)
      || lockLonger(next.autoLockMinutes, cur.autoLockMinutes)
      || lockLonger(next.clipboardSeconds, cur.clipboardSeconds)
      || (!!cur.backupDir && next.backupDir !== cur.backupDir);
  }

  applySettings(next) {
    this._require();
    this.data.settings = next;
    this.save();
    return this.getSettings();
  }

  // ----- security audit -----

  audit() {
    this._require();
    const live = this._live();
    const logins = live.filter((e) => e.type === 'login' && e.password);
    const weak = [];
    const old = [];
    const byPw = new Map();
    const yearAgo = Date.now() - 365 * 24 * 3600 * 1000;
    for (const e of logins) {
      const est = strength.estimate(e.password);
      if (est.score <= 1) weak.push({ id: e.id, title: e.title, username: e.username, label: est.label });
      const changed = Date.parse(e.passwordChanged || e.created);
      if (changed && changed < yearAgo) old.push({ id: e.id, title: e.title, username: e.username, changed: e.passwordChanged || e.created });
      const h = crypto.createHash('sha256').update(e.password).digest('hex');
      const list = byPw.get(h) || [];
      list.push({ id: e.id, title: e.title, username: e.username });
      byPw.set(h, list);
    }
    const reused = [...byPw.values()].filter((g) => g.length > 1);
    const reusedCount = reused.reduce((n, g) => n + g.length, 0);
    const no2fa = logins.filter((e) => !e.totp).length;
    const unprotectedKeys = live.filter((e) => e.type === 'apikey' && !e.reprompt).map((e) => ({ id: e.id, title: e.title, username: e.username }));
    const bad = new Set([...weak.map((x) => x.id), ...reused.flat().map((x) => x.id)]);
    const score = logins.length ? Math.round(100 * (1 - bad.size / logins.length) - (old.length / logins.length) * 10) : 100;
    return { total: logins.length, score: Math.max(0, Math.min(100, score)), weak, reused, reusedCount, old, no2fa, unprotectedKeys };
  }
}

module.exports = { Vault, VaultError, DEFAULT_SETTINGS, CURRENT_KDF, formatSecretKey, parseSecretKey, memoryKeyStore };
