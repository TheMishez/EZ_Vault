'use strict';
/*
 * Automatic rolling backups of the (already encrypted) vault file.
 *
 *  - A snapshot is taken after every save, named EZ-Vault-YYYY-MM-DD_HH.ezv (local time),
 *    so you get at most one per hour.
 *  - Last 48 hours: every hourly snapshot is kept.
 *  - Older: only the newest snapshot of each day is kept, up to `keepDays` days.
 *  - Can mirror to a second folder (USB stick, other drive).
 *
 * Backups are encrypted exactly like the vault: opening one needs the master password
 * that was current when it was made, plus your Secret Key.
 */
const fs = require('fs');
const path = require('path');

const RE = /^EZ-Vault-(\d{4})-(\d{2})-(\d{2})_(\d{2})\.ezv$/;
const RE_PRE = /^EZ-Vault-(pre-restore|pre-reset)-(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})\.ezv$/;
const pad = (n) => String(n).padStart(2, '0');

function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}`;
}

function parseName(name) {
  let m = RE.exec(name);
  if (m) return { kind: 'auto', date: new Date(+m[1], +m[2] - 1, +m[3], +m[4]) };
  m = RE_PRE.exec(name);
  if (m) return { kind: m[1], date: new Date(+m[2], +m[3] - 1, +m[4], +m[5], +m[6], +m[7]) };
  return null;
}

function copyAtomic(src, dest) {
  const tmp = dest + '.tmp';
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dest);
}

function list(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .map((name) => {
      const info = parseName(name);
      if (!info) return null;
      const p = path.join(dir, name);
      let size = 0;
      try { size = fs.statSync(p).size; } catch { return null; }
      return { name, path: p, kind: info.kind, date: info.date.toISOString(), size };
    })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date));
}

function prune(dir, keepDays, now = Date.now()) {
  const items = list(dir);
  const recentCutoff = now - 48 * 3600 * 1000;
  const oldCutoff = now - keepDays * 24 * 3600 * 1000;
  const seenDays = new Set();
  let removed = 0;
  for (const it of items) { // newest first
    const t = Date.parse(it.date);
    const day = it.date.slice(0, 10) + it.kind;
    let keep;
    if (t < oldCutoff) keep = false;
    else if (it.kind !== 'auto') keep = true;
    else if (t >= recentCutoff) keep = true;
    else keep = !seenDays.has(day);
    if (it.kind === 'auto') seenDays.add(day);
    if (!keep) { try { fs.unlinkSync(it.path); removed++; } catch { /* ignore */ } }
  }
  return removed;
}

/** Copies the vault into each folder and prunes. Returns per-folder results (never throws). */
function snapshot(vaultFile, dirs, keepDays = 30, when = new Date()) {
  const results = [];
  for (const dir of dirs.filter(Boolean)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      copyAtomic(vaultFile, path.join(dir, `EZ-Vault-${stamp(when)}.ezv`));
      prune(dir, keepDays, when.getTime());
      results.push({ dir, ok: true });
    } catch (err) {
      results.push({ dir, ok: false, error: err.message });
    }
  }
  return results;
}

function preRestoreCopy(vaultFile, dir, when = new Date(), label = 'pre-restore') {
  fs.mkdirSync(dir, { recursive: true });
  const name = `EZ-Vault-${label}-${stamp(when)}${pad(when.getMinutes())}${pad(when.getSeconds())}.ezv`;
  const dest = path.join(dir, name);
  copyAtomic(vaultFile, dest);
  return dest;
}

module.exports = { snapshot, list, prune, preRestoreCopy, stamp, copyAtomic };
