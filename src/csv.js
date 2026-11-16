'use strict';
// CSV import/export compatible with Chrome, Edge, Brave, Firefox, Bitwarden and 1Password-style exports.

function parse(text) {
  text = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

const COLUMN_ALIASES = {
  title: ['name', 'title', 'account', 'site', 'item name'],
  url: ['url', 'login_uri', 'website', 'web site', 'uri', 'urls', 'origin'],
  username: ['username', 'login_username', 'user', 'login', 'email', 'user name'],
  password: ['password', 'login_password', 'pass'],
  notes: ['note', 'notes', 'extra', 'comments'],
  totp: ['totp', 'login_totp', 'otp', 'otpauth', 'one-time password'],
  folder: ['folder', 'group', 'grouping', 'category']
};

function toEntries(text) {
  const rows = parse(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    if (idx !== -1) col[key] = idx;
  }
  if (col.password === undefined && col.username === undefined) {
    throw new Error('Could not find username/password columns in this CSV');
  }
  const out = [];
  for (const r of rows.slice(1)) {
    const get = (k) => (col[k] !== undefined ? (r[col[k]] || '').trim() : '');
    const url = get('url');
    let title = get('title');
    if (!title && url) {
      try { title = new URL(url.includes('://') ? url : 'https://' + url).hostname.replace(/^www\./, ''); }
      catch { title = url; }
    }
    if (!title && !get('username') && !get('password')) continue;
    out.push({
      type: 'login',
      title: title || 'Imported item',
      url,
      username: get('username'),
      password: col.password !== undefined ? (r[col.password] || '') : '',
      notes: get('notes'),
      totp: get('totp'),
      folder: get('folder')
    });
  }
  return out;
}

function esc(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function fromEntries(entries) {
  const head = ['name', 'url', 'username', 'password', 'note', 'totp', 'folder'];
  const lines = [head.join(',')];
  for (const e of entries) {
    lines.push([e.title, e.url, e.username, e.password, e.notes, e.totp, e.folder].map(esc).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

module.exports = { parse, toEntries, fromEntries };
