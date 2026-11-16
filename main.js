'use strict';
const { app, BrowserWindow, ipcMain, clipboard, dialog, powerMonitor, shell, Menu, session, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { Vault, VaultError } = require('./src/vault');
const { generate } = require('./src/generator');
const totp = require('./src/totp');
const csv = require('./src/csv');
const backups = require('./src/backups');

// ---------------------------------------------------------------- process hardening
// Refuse to run with debugger / remote-debugging switches in a packaged build (stops memory-dumping tricks).
if (app.isPackaged && process.argv.some((a) => /^--(inspect|remote-debugging|js-flags|debug)/i.test(a))) {
  process.exit(1);
}
app.enableSandbox();
app.commandLine.appendSwitch('js-flags', '--expose-gc');            // lets us force-collect freed secrets on lock
app.commandLine.appendSwitch('disable-features', 'Autofill,SpellcheckService');
app.setAppUserModelId('com.ezggco.ezvault');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null;
let vault = null;
let clipTimer = null;
let lastClip = null;
let lastActivity = Date.now();
let keyStore = null;
let lastBackup = null;   // results of the most recent automatic backup
let restoreCandidates = new Set();
const grants = new Map();   // itemId -> expiry ms, for "require master password" items
const GRANT_MS = 2 * 60 * 1000;

const userFile = (name) => path.join(app.getPath('userData'), name);
const APP_URL = pathToFileURL(path.join(__dirname, 'renderer') + path.sep).href;
const isAppUrl = (u) => { try { return decodeURIComponent(String(u)).toLowerCase().startsWith(decodeURIComponent(APP_URL).toLowerCase()); } catch { return false; } };
const localBackupDir = () => userFile('backups');
const vaultPath = () => process.env.EZVAULT_PATH || userFile('vault.ezv');

// ---------------------------------------------------------------- Secret Key store (Windows DPAPI)
// The Secret Key is encrypted with DPAPI, so only your Windows account on this PC can decrypt it.
function dpapiKeyStore() {
  const file = userFile('secret-keys.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const write = (obj) => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return {
    get(id) {
      const rec = read()[id];
      if (!rec) return null;
      try {
        const hex = rec.enc === 'dpapi' ? safeStorage.decryptString(Buffer.from(rec.data, 'base64')) : rec.data;
        return Buffer.from(hex, 'hex');
      } catch { return null; }
    },
    set(id, buf) {
      const all = read();
      const hex = buf.toString('hex');
      all[id] = safeStorage.isEncryptionAvailable()
        ? { enc: 'dpapi', data: safeStorage.encryptString(hex).toString('base64') }
        : { enc: 'none', data: hex };
      write(all);
    },
    remove(id) { const all = read(); delete all[id]; write(all); }
  };
}

// ---------------------------------------------------------------- persistent brute-force lockout
const lockout = {
  file: () => userFile('lockout.json'),
  read() { try { return JSON.parse(fs.readFileSync(this.file(), 'utf8')); } catch { return { fails: 0, until: 0 }; } },
  write(s) { fs.mkdirSync(path.dirname(this.file()), { recursive: true }); fs.writeFileSync(this.file(), JSON.stringify(s)); },
  check() {
    const s = this.read();
    const wait = Math.ceil((s.until - Date.now()) / 1000);
    if (wait > 0) throw new VaultError('LOCKED_OUT', `Too many wrong attempts. Try again in ${wait >= 60 ? Math.ceil(wait / 60) + ' min' : wait + 's'}.`);
  },
  fail() {
    const s = this.read();
    s.fails = (s.fails || 0) + 1;
    if (s.fails >= 5) s.until = Date.now() + Math.min(30000 * 2 ** (s.fails - 5), 15 * 60000);
    this.write(s);
    return s.fails;
  },
  reset() { this.write({ fails: 0, until: 0 }); }
};

async function verifyOrThrow(pw) {
  lockout.check();
  if (typeof pw !== 'string' || !pw || !(await vault.verifyMaster(pw))) {
    lockout.fail();
    throw new VaultError('BAD_PASSWORD', 'Wrong master password');
  }
  lockout.reset();
}
const reauthError = () => new VaultError('REAUTH', 'Enter your master password to continue');

// ---------------------------------------------------------------- window
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 740, minWidth: 920, minHeight: 580,
    frame: false, backgroundColor: '#0a0a0b', show: false, title: 'EZ Vault',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      spellcheck: false, devTools: !app.isPackaged, enableWebSQL: false, navigateOnDragDrop: false
    }
  });
  win.setContentProtection(true);
  loadUi();
  win.once('ready-to-show', () => win.show());
  win.on('minimize', () => {
    if (vault && vault.unlocked && vault.getSettings().lockOnMinimize) lockVault('minimize');
  });
  win.on('maximize', () => win.webContents.send('win:state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('win:state', { maximized: false }));
  win.on('closed', () => { win = null; });
}

function loadUi(reason) {
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), reason ? { query: { reason } } : undefined);
}

function lockVault(reason) {
  if (!vault || !vault.unlocked) return;
  vault.lock();
  grants.clear();
  if (win) {
    win.setContentProtection(true);
    loadUi(reason);    // full reload wipes every decrypted string from the UI's memory
  }
  setTimeout(() => { if (typeof global.gc === 'function') global.gc(); }, 500);
}

function applySettings() {
  if (win && vault && vault.unlocked) win.setContentProtection(vault.getSettings().streamerMode);
}

function copyToClipboard(text) {
  clipboard.writeText(text);
  lastClip = text;
  clearTimeout(clipTimer);
  const secs = vault && vault.unlocked ? vault.getSettings().clipboardSeconds : 15;
  if (secs > 0) {
    clipTimer = setTimeout(() => {
      if (clipboard.readText() === lastClip) clipboard.clear();
      lastClip = null;
    }, secs * 1000);
  }
  return { clearsIn: secs };
}

function clipboardHistoryStatus() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Clipboard'], { windowsHide: true, timeout: 3000 }, (err, out) => {
      if (err) return resolve({ history: false, cloud: false });
      const on = (name) => new RegExp(name + '\\s+REG_DWORD\\s+0x1\\b', 'i').test(out);
      resolve({ history: on('EnableClipboardHistory'), cloud: on('EnableCloudClipboard') });
    });
  });
}

// ---------------------------------------------------------------- item access (reprompt)
function granted(id) {
  const exp = grants.get(id);
  if (exp && exp > Date.now()) return true;
  grants.delete(id);
  return false;
}
function requireAccess(id) {
  const e = vault.get(id);
  if (e.reprompt && !granted(id)) throw reauthError();
  return e;
}

// ---------------------------------------------------------------- IPC
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents || !event.senderFrame || event.senderFrame.parent || !isAppUrl(event.senderFrame.url)) return { ok: false, error: 'Forbidden' };
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { return { ok: false, error: err.message || String(err), code: err.code }; }
  });
}

function initIpc() {
  keyStore = dpapiKeyStore();
  vault = new Vault(vaultPath(), {
    keyStore,
    onSaved: (file, s) => { lastBackup = { at: new Date().toISOString(), results: backups.snapshot(file, [localBackupDir(), s.backupDir], s.backupKeepDays) }; }
  });

  handle('vault:status', () => ({
    exists: vault.exists(), unlocked: vault.unlocked, needsSecretKey: vault.needsSecretKey(),
    dpapi: safeStorage.isEncryptionAvailable()
  }));
  handle('vault:create', async (pw) => {
    const kit = await vault.create(pw);
    lastActivity = Date.now(); applySettings();
    return { secretKey: kit };
  });
  handle('vault:unlock', async (pw, secretKeyText) => {
    lockout.check();
    let res;
    try { res = await vault.unlock(pw, secretKeyText || undefined); }
    catch (e) { if (e.code === 'BAD_PASSWORD') lockout.fail(); throw e; }
    lockout.reset();
    lastActivity = Date.now(); applySettings();
    return { secretKey: res.newSecretKey || null };
  });
  handle('vault:lock', () => { lockVault('manual'); return true; });
  // "Forgot master password" reset, from the lock screen. Keeps an encrypted copy unless wipeAll is set.
  handle('vault:reset', (opts) => {
    if (vault.unlocked) throw new Error('Lock the vault first');
    const wipeAll = !!(opts && opts.wipeAll);
    let keptCopy = null;
    if (vault.exists() && !wipeAll) keptCopy = backups.preRestoreCopy(vault.filePath, localBackupDir(), new Date(), 'pre-reset');
    for (const f of [vault.filePath, vault.filePath + '.bak', vault.filePath + '.tmp']) { try { fs.unlinkSync(f); } catch { /* not there */ } }
    if (wipeAll) {
      fs.rmSync(localBackupDir(), { recursive: true, force: true });
      for (const f of ['secret-keys.json', 'secret-keys.json.tmp']) { try { fs.unlinkSync(userFile(f)); } catch { /* not there */ } }
    }
    lockout.reset();
    grants.clear();
    return { keptCopy };
  });
  handle('vault:changeMaster', async (oldPw, newPw) => {
    lockout.check();
    try { await vault.changeMaster(oldPw, newPw); }
    catch (e) { if (e.code === 'BAD_PASSWORD') lockout.fail(); throw e; }
    lockout.reset();
    return true;
  });
  handle('vault:emergencyKit', async (pw) => { await verifyOrThrow(pw); return vault.secretKeyText(); });
  handle('vault:saveKit', async (text) => {
    const r = await dialog.showSaveDialog(win, { title: 'Save Emergency Kit', defaultPath: 'EZ-Vault-Emergency-Kit.txt', filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (r.canceled || !r.filePath) return null;
    const body = [
      'EZ VAULT — EMERGENCY KIT', '========================', '',
      'Secret Key:', '  ' + String(text).slice(0, 80), '',
      'Master password: ______________________________ (write it by hand, or keep it only in your head)', '',
      'You need BOTH to open your vault on a new PC or after reinstalling Windows.',
      'Print this, then delete this file. Keep the paper somewhere safe — not on this PC or in cloud storage.',
      '', 'EZGGco · EZ Vault'
    ].join('\r\n');
    fs.writeFileSync(r.filePath, body, { mode: 0o600 });
    return r.filePath;
  });
  handle('auth:grant', async (id, pw) => { await verifyOrThrow(pw); vault.get(id); grants.set(id, Date.now() + GRANT_MS); return true; });

  handle('entries:list', () => vault.list());
  handle('entries:get', (id) => {
    const e = vault.get(id);
    const open = !e.reprompt || granted(id);
    return { ...vault.view(id, { includeNotes: open }), locked: !open };
  });
  handle('entries:getForEdit', (id) => requireAccess(id));
  handle('entries:reveal', (id, field, index) => {
    const e = requireAccess(id);
    if (field === 'password') return e.password;
    if (field === 'history') return (e.history || [])[index | 0]?.password ?? '';
    throw new Error('Bad field');
  });
  handle('entries:save', (entry) => {
    if (entry && entry.id) requireAccess(entry.id);
    if (entry && entry.totp) {
      if (entry.totpKind === 'steam') entry.totp = totp.normalizeSteam(entry.totp);
      else if (!totp.isValid(entry.totp)) throw new Error('2FA secret is not valid base32 or otpauth:// link');
    }
    return vault.upsert(entry);
  });
  handle('entries:toggleFavorite', (id) => {
    const e = vault.get(id);
    return vault.upsert({ ...e, favorite: !e.favorite });
  });
  handle('entries:remove', (id) => { requireAccess(id); return vault.remove(id); });
  handle('trash:list', () => vault.trash());
  handle('trash:restore', (id) => { requireAccess(id); return vault.restore(id); });
  handle('trash:purge', (id) => { requireAccess(id); return vault.purge(id); });
  handle('trash:empty', async (pw) => {
    if (vault.trash().some((e) => e.reprompt)) { if (!pw) throw reauthError(); await verifyOrThrow(pw); }
    return vault.emptyTrash();
  });
  handle('entries:copy', (id, field, index) => {
    const e = ['username', 'url'].includes(field) ? vault.get(id) : requireAccess(id);
    if (field === 'totp') return copyToClipboard(totp.generate(e.totp).code);
    if (field === 'history') return copyToClipboard((e.history || [])[index | 0]?.password ?? '');
    if (field === 'notes') { if (e.reprompt && !granted(id)) throw reauthError(); return copyToClipboard(e.notes || ''); }
    if (!['username', 'password', 'url'].includes(field)) throw new Error('Bad field');
    return copyToClipboard(e[field] || '');
  });
  handle('entries:totp', (id) => {
    const e = requireAccess(id);
    return e.totp ? totp.generate(e.totp) : null;
  });

  handle('folders:list', () => vault.folders());
  handle('folders:add', (name) => vault.addFolder(name));
  handle('folders:remove', (name) => vault.removeFolder(name));

  handle('settings:get', () => vault.getSettings());
  handle('settings:set', async (patch, pw) => {
    patch = { ...(patch || {}) };
    if ('backupDir' in patch && patch.backupDir !== '') delete patch.backupDir; // folders are only chosen via the dialog
    const next = vault.normalizeSettings(patch);
    if (vault.weakens(next)) { if (!pw) throw reauthError(); await verifyOrThrow(pw); }
    const s = vault.applySettings(next);
    applySettings();
    return s;
  });

  handle('tools:generate', (opts) => generate(opts));
  handle('tools:copyGenerated', (text) => copyToClipboard(String(text).slice(0, 200)));
  handle('tools:audit', async () => ({ ...vault.audit(), clipboard: await clipboardHistoryStatus() }));
  handle('tools:openClipboardSettings', () => shell.openExternal('ms-settings:clipboard'));
  handle('tools:openUrl', (url) => {
    let u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    const parsed = new URL(u);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only web links can be opened');
    return shell.openExternal(parsed.href);
  });

  handle('data:importCsv', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import passwords (CSV)', filters: [{ name: 'CSV', extensions: ['csv'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const stat = fs.statSync(r.filePaths[0]);
    if (stat.size > 20 * 1024 * 1024) throw new Error('That file is too large to be a password export');
    return vault.importMany(csv.toEntries(fs.readFileSync(r.filePaths[0], 'utf8')));
  });
  handle('data:exportCsv', async (pw) => {
    await verifyOrThrow(pw);
    const r = await dialog.showSaveDialog(win, { title: 'Export UNENCRYPTED passwords', defaultPath: 'ez-vault-export.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, csv.fromEntries(vault.exportAll()), { mode: 0o600 });
    return r.filePath;
  });
  handle('data:backup', async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(win, { title: 'Save encrypted backup', defaultPath: `ez-vault-backup-${stamp}.ezv`, filters: [{ name: 'EZ Vault', extensions: ['ezv'] }] });
    if (r.canceled || !r.filePath) return null;
    vault.save();
    fs.copyFileSync(vault.filePath, r.filePath);
    return r.filePath;
  });
  handle('data:revealFolder', () => { shell.showItemInFolder(vault.filePath); return true; });

  // ----- automatic backups -----
  handle('backups:info', () => {
    const s = vault.getSettings();
    const local = backups.list(localBackupDir());
    const extra = s.backupDir ? backups.list(s.backupDir) : [];
    restoreCandidates = new Set([...local, ...extra].map((b) => b.path));
    return { localDir: localBackupDir(), extraDir: s.backupDir, keepDays: s.backupKeepDays, local: local.slice(0, 25), extra: extra.slice(0, 25), last: lastBackup };
  });
  handle('backups:chooseDir', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a second backup folder (USB drive or another disk)', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const next = vault.normalizeSettings({ backupDir: r.filePaths[0] });
    vault.applySettings(next); // save() also writes the first backup there
    return r.filePaths[0];
  });
  handle('backups:backupNow', () => { vault.save(); return lastBackup; });
  handle('backups:openFolder', (which) => {
    const dir = which === 'extra' ? vault.getSettings().backupDir : localBackupDir();
    if (!dir) return false;
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });
  handle('backups:pickFile', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Restore from a backup file', filters: [{ name: 'EZ Vault', extensions: ['ezv'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    restoreCandidates.add(r.filePaths[0]);
    return r.filePaths[0];
  });
  handle('backups:restore', async (file, pw) => {
    if (!restoreCandidates.has(file)) throw new Error('Pick the backup from the list or the file picker');
    lockout.check();
    // Probe a private copy, so opening it can never modify the original backup.
    const probePath = userFile('restore-probe.ezv');
    fs.copyFileSync(file, probePath);
    try {
      const probe = new Vault(probePath, { keyStore });
      try { await probe.unlock(pw); }
      catch (e) {
        if (e.code === 'BAD_PASSWORD') { lockout.fail(); throw new VaultError('BAD_PASSWORD', 'Wrong password for this backup (use the master password you had when it was made)'); }
        if (e.code === 'NEEDS_SECRET_KEY') throw new VaultError('NEEDS_SECRET_KEY', 'This backup was made with a different Secret Key');
        throw e;
      }
      probe.lock();
      lockout.reset();
      const safety = backups.preRestoreCopy(vault.filePath, localBackupDir());
      vault.lock();          // stop any further saves from the old in-memory copy
      grants.clear();
      backups.copyAtomic(probePath, vault.filePath);
      setTimeout(() => { if (win) { win.setContentProtection(true); loadUi('restored'); } }, 50);
      return { safetyCopy: safety };
    } finally {
      for (const f of [probePath, probePath + '.bak', probePath + '.tmp']) { try { fs.unlinkSync(f); } catch { /* not there */ } }
    }
  });

  handle('win:minimize', () => win.minimize());
  handle('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  handle('win:close', () => win.close());
  handle('app:info', () => ({ version: app.getVersion() }));

  ipcMain.on('activity', (event) => { if (win && event.sender === win.webContents) lastActivity = Date.now(); });
}

// ---------------------------------------------------------------- web-content lockdown
function lockDownSessions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // No network, ever: the UI may only load its own local files.
  ses.webRequest.onBeforeRequest((details, cb) => {
    const ok = isAppUrl(details.url) || (!app.isPackaged && details.url.startsWith('devtools://'));
    cb({ cancel: !ok });
  });
  ses.setProxy({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9' }).catch(() => {});
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
  contents.on('will-navigate', (ev) => ev.preventDefault());
  contents.on('will-redirect', (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (app.isPackaged) contents.on('devtools-opened', () => contents.closeDevTools());
});

// ---------------------------------------------------------------- auto-lock
function startAutoLock() {
  setInterval(() => {
    if (!vault || !vault.unlocked) return;
    const mins = vault.getSettings().autoLockMinutes;
    if (mins > 0 && Date.now() - lastActivity > mins * 60000) lockVault('idle');
  }, 5000);
  powerMonitor.on('lock-screen', () => lockVault('system'));
  powerMonitor.on('suspend', () => lockVault('system'));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  lockDownSessions();
  initIpc();
  createWindow();
  startAutoLock();
});

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.on('before-quit', () => {
  if (lastClip && clipboard.readText() === lastClip) clipboard.clear();
  if (vault) vault.lock();
});

app.on('window-all-closed', () => app.quit());
