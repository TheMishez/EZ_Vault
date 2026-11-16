// Browser-only stand-in for preload.js, used to preview the UI without Electron.
(() => {
  const listeners = { locked: [] };
  let unlocked = false, exists = true;
  const days = (n) => new Date(Date.now() - n * 864e5).toISOString();
  let entries = [
    { id: '1', type: 'login', title: 'Steam', username: 'mishez', password: 'Xk9#vQ2!mZ7$pL4@rT', url: 'https://store.steampowered.com', folder: 'Gaming', favorite: true, totp: 'steam://OJZ2BP6KO2SLUD7I23Q5AYZELZB5OAFU', notes: '', created: days(400), updated: days(3), passwordChanged: days(3), history: [{ password: 'oldSteamPw1', changed: days(3) }] },
    { id: '2', type: 'login', title: 'FACEIT', username: 'mishez', password: 'Xk9#vQ2!mZ7$pL4@rT', url: 'https://faceit.com', folder: 'Gaming', favorite: true, totp: '', notes: '', created: days(200), updated: days(20), passwordChanged: days(20), history: [] },
    { id: '3', type: 'login', title: 'Discord', username: 'mish@ezggco.com', password: 'password123', url: 'https://discord.com', folder: 'Socials', favorite: false, totp: 'JBSWY3DPEHPK3PXP', notes: '', created: days(500), updated: days(500), passwordChanged: days(500), history: [] },
    { id: '4', type: 'login', title: 'X (Twitter)', username: '@EZGGco', password: 'Tq8&nW3%hY6^bV1', url: 'https://x.com', folder: 'Socials', favorite: false, totp: '', notes: '', created: days(30), updated: days(30), passwordChanged: days(30), history: [] },
    { id: '5', type: 'login', title: 'Porkbun', username: 'ezggco@gmail.com', password: 'R7!kd9#Lm2$Qz8&Wp', url: 'https://porkbun.com', folder: 'Work', favorite: false, totp: '', notes: 'Domain registrar for ezggco.com', created: days(90), updated: days(90), passwordChanged: days(90), history: [] },
    { id: '7', type: 'apikey', title: 'OpenAI', username: 'ezggco-prod', password: 'sk-proj-abc123', url: 'https://platform.openai.com', folder: 'API Keys', favorite: false, reprompt: true, totp: '', notes: 'Used by the site backend', created: days(5), updated: days(5), passwordChanged: days(5), history: [] },
    { id: '8', type: 'login', title: 'Old forum account', username: 'mish', password: 'abc', url: '', folder: '', favorite: false, totp: '', notes: '', created: days(900), updated: days(3), deletedAt: days(3), history: [] },
    { id: '6', type: 'note', title: 'Router admin', username: '', password: '', url: '', folder: '', favorite: false, totp: '', notes: 'Admin panel: 192.168.1.1\nWi-Fi: EZGG-5G\nKey: hunter2-but-longer-and-better', created: days(10), updated: days(10), history: [] }
  ];
  let folders = ['Gaming', 'Socials', 'Email', 'Finance', 'Work', 'API Keys']; const grants = new Set(); let needsKey = false;
  let settings = { autoLockMinutes: 10, clipboardSeconds: 20, lockOnMinimize: false, streamerMode: true, generator: { length: 20, upper: true, lower: true, digits: true, symbols: true, avoidAmbiguous: false } };
  const summary = (e) => ({ id: e.id, type: e.type, title: e.title, username: e.username, url: e.url, folder: e.folder, favorite: e.favorite, reprompt: !!e.reprompt, hasTotp: !!e.totp, hasPassword: !!e.password });
  const reauth = () => { const e = new Error('Enter your master password to continue'); e.code = 'REAUTH'; return e; };
  const access = (id) => { const e = entries.find((x) => x.id === id); if (e.reprompt && !grants.has(id)) throw reauth(); return e; };
  const gen = (o) => { const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*'; let s = ''; const a = new Uint32Array(o.length || 20); crypto.getRandomValues(a); for (const n of a) s += cs[n % cs.length]; return s; };
  window.ezvault = {
    status: async () => ({ exists, unlocked, needsSecretKey: needsKey, dpapi: true }),
    create: async () => { exists = true; unlocked = true; return { secretKey: 'EZ1-K7QM-3XRA-PW2D-9F5T-LNBC-Y6HE-ZJ4U-VGS8'.replace('8', 'Q') }; },
    unlock: async (pw, key) => { await new Promise((r) => setTimeout(r, 300)); if (needsKey && !key) { const e = new Error('This PC needs your Secret Key from your Emergency Kit'); e.code = 'NEEDS_SECRET_KEY'; throw e; } if (pw !== 'test') { const e = new Error('Wrong master password'); e.code = 'BAD_PASSWORD'; throw e; } unlocked = true; return {}; },
    lock: async () => { unlocked = false; location.search = '?reason=manual'; },
    changeMaster: async () => {},
    emergencyKit: async (pw) => { if (pw !== 'test') { const e = new Error('Wrong master password'); e.code = 'BAD_PASSWORD'; throw e; } return 'EZ1-K7QM-3XRA-PW2D-9F5T-LNBC-Y6HE-ZJ4U-VGSQ'; },
    saveKit: async () => 'x.txt',
    grant: async (id, pw) => { if (pw !== 'test') { const e = new Error('Wrong master password'); e.code = 'BAD_PASSWORD'; throw e; } grants.add(id); },
    getForEdit: async (id) => structuredClone(access(id)),
    reveal: async (id, f, i) => { const e = access(id); return f === 'history' ? e.history[i].password : e.password; },
    toggleFavorite: async (id) => { const e = entries.find((x) => x.id === id); e.favorite = !e.favorite; },
    copyGenerated: async () => ({ clearsIn: settings.clipboardSeconds }),
    openClipboardSettings: async () => {},
    _needsKey: (v) => { needsKey = v; },
    reportSecurity: async () => {},
    updateStatus: async () => ({ state: 'ready', current: '1.3.0', version: '1.3.1', percent: 100, auto: true, checkedAt: new Date().toISOString() }),
    checkForUpdates: async () => ({ state: 'current', current: '1.3.0', auto: true, checkedAt: new Date().toISOString() }),
    setAutoUpdate: async (on) => ({ state: 'ready', current: '1.3.0', version: '1.3.1', auto: on }),
    installUpdate: async () => true, openReleaseNotes: async () => {},
    onUpdate: () => {},
    resetVault: async (o) => { exists = false; return { keptCopy: o && o.wipeAll ? null : 'x' }; },
    list: async () => entries.filter((e) => !e.deletedAt).map(summary),
    trash: async () => entries.filter((e) => e.deletedAt).map((e) => ({ ...summary(e), deletedAt: e.deletedAt })),
    restoreItem: async (id) => { delete entries.find((x) => x.id === id).deletedAt; },
    purge: async (id) => { entries = entries.filter((e) => e.id !== id); },
    emptyTrash: async () => { const n = entries.filter((e) => e.deletedAt).length; entries = entries.filter((e) => !e.deletedAt); return n; },
    backupInfo: async () => ({ localDir: 'C:\\Users\\Mish\\AppData\\Roaming\\EZ Vault\\backups', extraDir: '', keepDays: 30, last: { results: [{ ok: true }] },
      local: [0, 1, 2, 26, 50, 74].map((h, i) => ({ path: 'b' + i, kind: 'auto', date: new Date(Date.now() - h * 3600e3).toISOString() })), extra: [] }),
    chooseBackupDir: async () => null, backupNow: async () => ({}), openBackupFolder: async () => {}, pickBackupFile: async () => null, restoreBackup: async () => ({}),
    get: async (id) => { const e = entries.find((x) => x.id === id); const open = !e.reprompt || grants.has(id); return { id: e.id, type: e.type, title: e.title, username: e.username, url: e.url, folder: e.folder, favorite: e.favorite, reprompt: !!e.reprompt, notes: open ? e.notes : '', hasPassword: !!e.password, hasTotp: !!e.totp, passwordScore: e.password ? window.EZStrength.estimate(e.password) : null, totpKind: (e.totp || '').startsWith('steam://') ? 'steam' : 'totp', deletedAt: e.deletedAt || null, history: e.history.map((h) => ({ changed: h.changed })), created: e.created, updated: e.updated, passwordChanged: e.passwordChanged, locked: !open }; },
    save: async (e) => { if (e.id) { Object.assign(entries.find((x) => x.id === e.id), e); return e.id; } const id = String(Date.now()); entries.push({ ...e, id, created: new Date().toISOString(), updated: new Date().toISOString(), history: [] }); return id; },
    remove: async (id) => { entries.find((x) => x.id === id).deletedAt = new Date().toISOString(); },
    copy: async (id, f) => { if (!['username', 'url'].includes(f)) access(id); return { clearsIn: settings.clipboardSeconds }; },
    totp: async (id) => { const s = Math.floor(Date.now() / 1000); const steam = (entries.find((x) => x.id === id).totp || '').startsWith('steam'); return { code: steam ? 'K7MXQ' : String(482913 + (Math.floor(s / 30) % 7) * 11111).slice(0, 6), period: 30, remaining: 30 - (s % 30), steam }; },
    folders: async () => folders,
    addFolder: async (n) => (folders = [...folders, n]),
    removeFolder: async (n) => (folders = folders.filter((f) => f !== n)),
    getSettings: async () => structuredClone(settings),
    setSettings: async (p, pw) => { if (p.streamerMode === false && settings.streamerMode && !pw) { const e = new Error('re'); e.code = 'REAUTH'; throw e; } return (settings = { ...settings, ...p }); },
    generate: async (o) => o.mode === 'passphrase' ? { value: 'Tundra-Blaster-Ozone7-Ripple-Mango-Fable', bits: 75 } : { value: gen(o), bits: 131 },
    copyText: async () => ({ clearsIn: settings.clipboardSeconds }),
    audit: async () => ({ total: 5, score: 52, weak: [{ id: '3', title: 'Discord', username: 'mish@ezggco.com', label: 'Very weak' }], reused: [[{ id: '1', title: 'Steam', username: 'mishez' }, { id: '2', title: 'FACEIT', username: 'mishez' }]], reusedCount: 2, old: [{ id: '3', title: 'Discord', changed: days(500) }], no2fa: 3, unprotectedKeys: [], clipboard: { history: true, cloud: false } }),
    openUrl: async () => {}, importCsv: async () => null, exportCsv: async () => null, backup: async () => null, revealFolder: async () => {},
    minimize: async () => {}, maximize: async () => {}, close: async () => {}, info: async () => ({ version: '1.0.0' }),
    ping: () => {},
    onLocked: (cb) => listeners.locked.push(cb),
    onWinState: () => {},
    _setExists: (v) => { exists = v; }
  };
  // Mirror the real preload: never throw; failures come back as { ok:false, error, code }.
  const raw = window.ezvault;
  const wrapped = {};
  for (const [k, fn] of Object.entries(raw)) {
    if (typeof fn !== 'function' || ['ping', 'onWinState', 'onUpdate'].includes(k) || k.startsWith('_')) { wrapped[k] = fn; continue; }
    wrapped[k] = async (...a) => { try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message, code: e.code }; } };
  }
  window.ezvault = wrapped;
})();
