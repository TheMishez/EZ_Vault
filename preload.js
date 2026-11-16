'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Returns the plain { ok, data } / { ok:false, error, code } object.
// We don't throw here: Electron's contextBridge strips custom properties (like .code)
// from Error objects, so the renderer re-creates the error on its side (see app.js).
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  return res && typeof res === 'object' ? { ok: !!res.ok, data: res.data, error: res.error, code: res.code } : { ok: false, error: 'No response' };
}

let lastPing = 0;
function ping() {
  const now = Date.now();
  if (now - lastPing > 3000) { lastPing = now; ipcRenderer.send('activity'); }
}

contextBridge.exposeInMainWorld('ezvault', Object.freeze({
  status: () => call('vault:status'),
  create: (pw) => call('vault:create', pw),
  unlock: (pw, secretKey) => call('vault:unlock', pw, secretKey),
  lock: () => call('vault:lock'),
  resetVault: (opts) => call('vault:reset', opts),
  changeMaster: (o, n) => call('vault:changeMaster', o, n),
  emergencyKit: (pw) => call('vault:emergencyKit', pw),
  saveKit: (text) => call('vault:saveKit', text),
  grant: (id, pw) => call('auth:grant', id, pw),

  list: () => call('entries:list'),
  get: (id) => call('entries:get', id),
  getForEdit: (id) => call('entries:getForEdit', id),
  reveal: (id, field, index) => call('entries:reveal', id, field, index),
  save: (entry) => call('entries:save', entry),
  toggleFavorite: (id) => call('entries:toggleFavorite', id),
  remove: (id) => call('entries:remove', id),
  trash: () => call('trash:list'),
  restoreItem: (id) => call('trash:restore', id),
  purge: (id) => call('trash:purge', id),
  emptyTrash: (pw) => call('trash:empty', pw),

  backupInfo: () => call('backups:info'),
  chooseBackupDir: () => call('backups:chooseDir'),
  backupNow: () => call('backups:backupNow'),
  openBackupFolder: (which) => call('backups:openFolder', which),
  pickBackupFile: () => call('backups:pickFile'),
  restoreBackup: (file, pw) => call('backups:restore', file, pw),
  copy: (id, field, index) => call('entries:copy', id, field, index),
  totp: (id) => call('entries:totp', id),

  folders: () => call('folders:list'),
  addFolder: (n) => call('folders:add', n),
  removeFolder: (n) => call('folders:remove', n),

  getSettings: () => call('settings:get'),
  setSettings: (p, pw) => call('settings:set', p, pw),

  generate: (o) => call('tools:generate', o),
  copyGenerated: (t) => call('tools:copyGenerated', t),
  audit: () => call('tools:audit'),
  openUrl: (u) => call('tools:openUrl', u),
  openClipboardSettings: () => call('tools:openClipboardSettings'),

  importCsv: () => call('data:importCsv'),
  exportCsv: (pw) => call('data:exportCsv', pw),
  backup: () => call('data:backup'),
  revealFolder: () => call('data:revealFolder'),

  minimize: () => call('win:minimize'),
  maximize: () => call('win:maximize'),
  close: () => call('win:close'),
  info: () => call('app:info'),

  ping,
  onWinState: (cb) => ipcRenderer.on('win:state', (_e, d) => cb(d))
}));
