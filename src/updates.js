'use strict';
/*
 * Auto-update from GitHub Releases (electron-updater).
 *
 * Security notes:
 *  - Only the main process talks to the network, in electron-updater's own session.
 *    The UI's session stays fully blocked from the internet, and the vault is never sent anywhere.
 *  - Every download is checked against the SHA-512 hash published in the release (latest.yml)
 *    before it can install. Downgrades and pre-releases are refused.
 *  - Once the .exe is code-signed, set "publisherName" under build.win in package.json:
 *    electron-updater will then also refuse any update not signed by that publisher.
 *  - Works in the installed (NSIS) build only. The portable .exe and `npm start` can't self-update.
 */
const { app, shell } = require('electron');
const fs = require('fs');

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 15 * 1000;

let updater = null;
let getWindow = () => null;
let prefsFile = null;
let timer = null;
const state = { state: 'idle', current: app.getVersion(), version: null, percent: 0, error: null, checkedAt: null, auto: true };

function readPrefs() { try { return JSON.parse(fs.readFileSync(prefsFile, 'utf8')); } catch { return {}; } }
function writePrefs(p) { try { fs.writeFileSync(prefsFile, JSON.stringify(p)); } catch { /* non-fatal */ } }

function set(patch) {
  Object.assign(state, patch);
  const w = getWindow();
  if (w && !w.isDestroyed()) w.webContents.send('update:status', status());
}

function status() { return { ...state }; }

function friendlyError(err) {
  const msg = String((err && err.message) || err || 'Unknown error');
  if (/404|Cannot find latest|No published versions/i.test(msg)) return 'No releases have been published yet.';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR_/i.test(msg)) return 'Couldn’t reach GitHub — check your internet connection.';
  if (/sha512|checksum/i.test(msg)) return 'The download failed its integrity check and was discarded.';
  if (/signature|publisher/i.test(msg)) return 'The update was not signed by EZGGco and was rejected.';
  return msg.split('\n')[0].slice(0, 160);
}

function init(opts) {
  getWindow = opts.getWindow;
  prefsFile = opts.userFile('prefs.json');
  state.auto = readPrefs().autoUpdate !== false;

  if (!app.isPackaged) return set({ state: 'dev' });
  if (process.env.PORTABLE_EXECUTABLE_DIR) return set({ state: 'portable' });
  try { ({ autoUpdater: updater } = require('electron-updater')); }
  catch { return set({ state: 'unavailable', error: 'Updater component missing' }); }

  updater.logger = null;            // never write update logs
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;

  updater.on('checking-for-update', () => set({ state: 'checking', error: null }));
  updater.on('update-available', (i) => set({ state: 'downloading', version: i.version, percent: 0 }));
  updater.on('update-not-available', () => set({ state: 'current', version: null, checkedAt: new Date().toISOString() }));
  updater.on('download-progress', (p) => set({ percent: Math.round(p.percent || 0) }));
  updater.on('update-downloaded', (i) => set({ state: 'ready', version: i.version, percent: 100, checkedAt: new Date().toISOString() }));
  updater.on('error', (e) => set({ state: 'error', error: friendlyError(e) }));

  if (state.auto) schedule();
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(function tick() {
    check(false);
    timer = setTimeout(tick, CHECK_EVERY_MS);
  }, FIRST_CHECK_MS);
}

async function check(manual) {
  if (['dev', 'portable', 'unavailable'].includes(state.state)) return status();
  if (!updater || ['checking', 'downloading', 'ready'].includes(state.state)) return status();
  try { await updater.checkForUpdates(); }
  catch (e) { set({ state: 'error', error: friendlyError(e) }); }
  return status();
}

function setAuto(on) {
  state.auto = on;
  writePrefs({ ...readPrefs(), autoUpdate: on });
  if (on && updater) schedule(); else clearTimeout(timer);
  set({});
  return status();
}

function install() {
  if (!updater || state.state !== 'ready') throw new Error('No update is ready to install');
  setImmediate(() => updater.quitAndInstall(false, true)); // show installer progress, relaunch after
  return true;
}

function openNotes() {
  const repo = String((require('../package.json').repository || {}).url || '').replace(/\.git$/, '').replace(/\/$/, '');
  const tag = state.version ? `/releases/tag/v${state.version}` : '/releases';
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('No repository set');
  return shell.openExternal(repo + tag);
}

module.exports = { init, check, status, setAuto, install, openNotes };
