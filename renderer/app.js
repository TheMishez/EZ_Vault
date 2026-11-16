/* EZ Vault renderer — vanilla JS, no innerHTML with user data (everything goes through el()).
 * The UI never holds the encryption key. Passwords and 2FA secrets are fetched one at a time,
 * only when you reveal, copy or edit them, and the whole page is reloaded on lock. */
'use strict';

// Wraps the preload bridge: unwraps { ok, data } and turns failures into Errors that keep their .code
// (REAUTH, BAD_PASSWORD, NEEDS_SECRET_KEY, LOCKED…). Done here because contextBridge drops .code.
const RAW_API = window.ezvault;
const PASSTHROUGH = new Set(['ping', 'onWinState', 'onUpdate']);
const api = new Proxy({}, {
  get(_t, key) {
    const fn = RAW_API[key];
    if (typeof fn !== 'function' || PASSTHROUGH.has(key)) return fn;
    return async (...args) => {
      const res = await fn(...args);
      if (!res || !res.ok) {
        const err = new Error((res && res.error) || 'Unknown error');
        err.code = res && res.code;
        throw err;
      }
      return res.data;
    };
  }
});
const S = {
  entries: [],
  trash: [],
  folders: [],
  settings: null,
  view: 'all',          // all | fav | login | note | apikey | folder | trash
  folder: null,
  query: '',
  selectedId: null,
  mode: 'view',         // view | edit | new
  tool: null,           // generator | security | settings | null
  totpTimer: null,
  dirty: false
};

const TYPE_META = {
  login: { label: 'Login', icon: 'key' },
  apikey: { label: 'API key', icon: 'code' },
  note: { label: 'Secure note', icon: 'note' }
};

// ---------------------------------------------------------------- helpers
function el(tag, props, ...children) {
  const node = tag === 'svg' || tag === 'path' || tag === 'circle'
    ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.setAttribute('class', v);
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked') node.checked = !!v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
const $ = (id) => document.getElementById(id);
const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

const ICONS = {
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eyeOff: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M3 3l18 18',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-4.2-4.2',
  lock: 'M6 11h12v10H6z M8 11V7a4 4 0 0 1 8 0v4',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1',
  dice: 'M4 4h16v16H4z M8.5 8.5h.01 M15.5 15.5h.01 M15.5 8.5h.01 M8.5 15.5h.01 M12 12h.01',
  folder: 'M3 6h6l2 2h10v11H3z',
  grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  note: 'M6 3h9l4 4v14H6z M14 3v5h5 M9 13h7 M9 17h5',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M4 21c1-4 4-6 8-6s7 2 8 6',
  key: 'M8 11a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M11 13l9-9 M17 7l3 3 M15 9l2 2',
  link: 'M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1 M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16z M13 7l4 4',
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
  x: 'M6 6l12 12M18 6L6 18',
  min: 'M6 12h12',
  max: 'M6 6h12v12H6z',
  restore: 'M8 8h10v10H8z M6 16V6h10',
  check: 'M5 12l5 5 9-10',
  upload: 'M12 16V4 M7 9l5-5 5 5 M4 20h16',
  download: 'M12 4v12 M7 11l5 5 5-5 M4 20h16',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 2',
  alert: 'M12 3l10 18H2z M12 10v5 M12 18h.01',
  history: 'M3 12a9 9 0 1 0 3-6.7 M3 4v5h5 M12 8v4l3 2',
  totp: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5h4',
  stream: 'M3 6h18v12H3z M10 9.5v5l4.5-2.5z',
  code: 'M8 7l-5 5 5 5 M16 7l5 5-5 5 M14 4l-4 16'
};
function icon(name, size = 16) {
  const svg = el('svg', { viewBox: '0 0 24 24', width: size, height: size, class: 'ic', 'aria-hidden': 'true' });
  svg.append(el('path', { d: ICONS[name] || '' }));
  return svg;
}
function iconBtn(name, title, onClick, cls = '') {
  return el('button', { class: 'icon-btn ' + cls, title, 'aria-label': title, onclick: onClick }, icon(name));
}

function toast(msg, kind = 'info', ms = 2600, action = null) {
  const t = el('div', { class: 'toast toast-' + kind }, icon(kind === 'error' ? 'alert' : 'check', 15), el('span', { text: msg }),
    action ? el('button', { class: 'toast-action', text: action.label, onclick: () => { t.remove(); action.fn(); } }) : null);
  $('toasts').append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, ms);
}


function modal({ title, body, confirmText = 'Confirm', cancelText = 'Cancel', danger = false, input = null, content = null, wide = false, noCancel = false }) {
  return new Promise((resolve) => {
    const root = $('modal-root');
    let field = null;
    if (input) {
      field = input.password
        ? passwordInput({ placeholder: input.placeholder || '' })
        : { input: el('input', { class: 'input', type: 'text', placeholder: input.placeholder || '', value: input.value || '', maxlength: 60 }) };
    }
    const done = (val) => { if (field) field.input.value = ''; clear(root); document.removeEventListener('keydown', onKey, true); resolve(val); };
    const ok = () => done(input ? (input.password ? (field.input.value || null) : (field.input.value.trim() || null)) : true);
    const cancel = () => { if (!noCancel) done(input ? null : false); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); e.stopPropagation(); ok(); }
    };
    document.addEventListener('keydown', onKey, true);
    root.append(el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === e.currentTarget) cancel(); } },
      el('div', { class: 'modal' + (wide ? ' modal-wide' : ''), role: 'dialog' },
        el('h3', { text: title }),
        body ? el('p', { class: 'modal-body', text: body }) : null,
        content,
        field ? (field.wrap || field.input) : null,
        el('div', { class: 'modal-actions' },
          noCancel ? null : el('button', { class: 'btn btn-ghost', text: cancelText, onclick: cancel }),
          el('button', { class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), text: confirmText, onclick: ok })))));
    setTimeout(() => (field ? field.input : root.querySelector('.btn-primary, .btn-danger')).focus(), 30);
  });
}

const askMaster = (body = 'Enter your master password to continue.') =>
  modal({ title: 'Confirm it’s you', body, confirmText: 'Confirm', input: { password: true, placeholder: 'Master password' } });

async function guard(fn) {
  try { return await fn(); }
  catch (e) {
    if (e.code === 'LOCKED') return api.lock();
    toast(e.message, 'error', 3800);
    return undefined;
  }
}

/** Runs fn(pw). If main says the action needs re-authentication, asks for the master password and retries. */
async function withReauth(fn, prompt) {
  try { return await fn(undefined); }
  catch (e) {
    if (e.code !== 'REAUTH') throw e;
    const pw = await askMaster(prompt);
    if (!pw) return undefined;
    return fn(pw);
  }
}

/** For "require master password" items: unlocks the item for 2 minutes, then retries. */
async function withItem(id, fn) {
  return guard(async () => {
    try { return await fn(); }
    catch (e) {
      if (e.code !== 'REAUTH') throw e;
      const pw = await askMaster('This item is protected. Enter your master password to unlock it for 2 minutes.');
      if (!pw) return undefined;
      await api.grant(id, pw);
      return fn();
    }
  });
}

function meterFrom(est, hasValue = true) {
  const score = hasValue ? est.score : -1;
  return el('div', { class: 'meter s' + (hasValue ? est.score : 'x') },
    el('div', { class: 'meter-bars' }, [0, 1, 2, 3, 4].map((i) => el('span', { class: i <= score ? 'on' : '' }))),
    el('span', { class: 'meter-label', text: hasValue ? `${est.label} · ~${est.bits} bits` : 'Strength' }));
}
function meterFromBits(bits) {
  const score = bits < 28 ? 0 : bits < 45 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
  return meterFrom({ bits, score, label: ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'][score] });
}
const strengthMeter = (pw) => meterFrom(window.EZStrength.estimate(pw || ''), !!pw);

/** Collapsible plain-English explanation of the "bits" number shown by the strength meter. */
function bitsExplainer() {
  const rows = [
    ['28', '~268 million', 'Cracked in seconds', 's0'],
    ['45', '~35 trillion', 'Hours to days on a gaming GPU', 's1'],
    ['60', '~1 quintillion', 'Years for a determined attacker', 's2'],
    ['80', '~1.2 septillion', 'Beyond any realistic attacker', 's3'],
    ['128', '~3.4 × 10³⁸', 'Practically uncrackable', 's4']
  ];
  return el('details', { class: 'bits-help' },
    el('summary', {}, icon('alert', 13), el('span', { text: 'What do “bits” mean?' })),
    el('p', { text: 'Bits measure how many guesses an attacker would need to brute-force a password. Every extra bit doubles the number of guesses.' }),
    el('div', { class: 'bits-table' },
      el('span', { class: 'bt-h', text: 'Bits' }), el('span', { class: 'bt-h', text: 'Guesses needed' }), el('span', { class: 'bt-h', text: 'What that means' }),
      rows.map(([b, g, m, cls]) => [el('span', { class: 'bt-b ' + cls, text: b }), el('span', { class: 'mono', text: g }), el('span', { text: m })])),
    el('p', { class: 'bits-scale', text: 'Very weak < 28 · Weak 28–44 · Fair 45–59 · Strong 60–79 · Very strong 80+' }),
    el('p', { class: 'muted', text: 'Aim for “Strong” or better for your master password. A passphrase of 5–6 random words (like “Tundra-Blaster-Ozone7-Ripple-Mango”) is ideal: strong and easy to remember. Note: for passwords you type yourself this is an estimate — it can’t tell if you used your dog’s name.' }));
}

function passwordInput({ id, placeholder, value = '', autofocus = false, oninput }) {
  const input = el('input', { class: 'input mono', type: 'password', id, placeholder, value, autocomplete: 'off', spellcheck: 'false', oninput });
  if (autofocus) setTimeout(() => input.focus(), 30);
  const toggle = el('button', { class: 'input-addon', type: 'button', title: 'Show / hide', tabindex: '-1' }, icon('eye'));
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    clear(toggle).append(icon(show ? 'eyeOff' : 'eye'));
  });
  return { wrap: el('div', { class: 'input-wrap' }, input, toggle), input };
}

function initials(title) {
  const t = (title || '?').replace(/^https?:\/\/(www\.)?/i, '').trim();
  return (t[0] || '?').toUpperCase();
}
function avatar(e, size = '') {
  const meta = TYPE_META[e.type] || TYPE_META.login;
  const isIcon = e.type !== 'login';
  return el('div', { class: `avatar ${size} ${isIcon ? 'avatar-' + e.type : ''}` }, isIcon ? icon(meta.icon, size === 'avatar-lg' ? 22 : 16) : initials(e.title));
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------- lock screen
async function boot() {
  wireWindow();
  ['mousemove', 'keydown', 'mousedown', 'wheel'].forEach((ev) => document.addEventListener(ev, () => api.ping(), { passive: true }));
  document.addEventListener('keydown', onGlobalKey);
  wireUpdates();
  const reason = new URLSearchParams(location.search).get('reason');
  const st = await api.status();
  if (st.unlocked) await enterApp(); else showLock({ ...st, reason });
}

// ---------------------------------------------------------------- updates
let UPD = null;
function wireUpdates() {
  api.onUpdate((u) => { const was = UPD && UPD.state; UPD = u; renderUpdateChip(); if (S.tool === 'settings' && $('upd-card')) renderUpdateCard($('upd-card')); if (u.state === 'ready' && was !== 'ready') toast(`EZ Vault ${u.version} is ready — restart to update`, 'info', 6000); });
  api.updateStatus().then((u) => { UPD = u; renderUpdateChip(); }).catch(() => {});
}
function renderUpdateChip() {
  const chip = $('tb-update');
  const ready = UPD && UPD.state === 'ready';
  chip.classList.toggle('hidden', !ready);
  if (!ready) return;
  clear(chip).append(icon('download', 13), el('span', { text: `Update ${UPD.version} ready · Restart` }));
  chip.onclick = installUpdate;
}
async function installUpdate() {
  if (!(await modal({ title: `Install EZ Vault ${UPD.version}?`, body: 'EZ Vault will lock, close, install the update and reopen. Your vault and settings are kept.', confirmText: 'Restart & update' }))) return;
  await guard(() => api.installUpdate());
}
function renderUpdateCard(card) {
  const u = UPD || { state: 'idle', current: '?' };
  const line = {
    dev: 'Updates only work in the installed version (not when running with npm start).',
    portable: 'The portable version can’t update itself. Download the latest release from GitHub, or use the installer.',
    unavailable: 'The update component is missing from this build.',
    idle: 'Not checked yet.',
    checking: 'Checking GitHub for updates…',
    current: `You’re up to date${u.checkedAt ? ' · checked ' + new Date(u.checkedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}.`,
    downloading: `Downloading ${u.version}… ${u.percent || 0}%`,
    ready: `Version ${u.version} is downloaded and verified.`,
    error: u.error || 'Update check failed.'
  }[u.state] || '';
  const canCheck = !['dev', 'portable', 'unavailable', 'checking', 'downloading', 'ready'].includes(u.state);
  clear(card).append(
    el('h3', {}, icon('refresh', 16), ' Updates'),
    el('div', { class: 'set-row' },
      el('div', {}, el('b', { text: `EZ Vault ${u.current}` }),
        el('p', { class: 'muted upd-line' + (u.state === 'error' ? ' upd-err' : ''), text: line }),
        u.state === 'downloading' ? el('div', { class: 'upd-bar' }, (() => { const f = el('span'); f.style.width = (u.percent || 0) + '%'; return f; })()) : null),
      el('div', { class: 'row-gap' },
        u.state === 'ready'
          ? el('button', { class: 'btn btn-primary', onclick: installUpdate }, icon('download', 14), el('span', { text: 'Restart & update' }))
          : el('button', { class: 'btn btn-ghost', disabled: canCheck ? null : 'disabled', onclick: async () => { const r = await guard(() => api.checkForUpdates()); if (r) { UPD = r; renderUpdateCard(card); } } }, icon('refresh', 14), el('span', { text: 'Check now' })),
        ['ready', 'downloading', 'current'].includes(u.state) && u.version ? iconBtn('external', 'What’s new', () => guard(() => api.openReleaseNotes())) : null)),
    el('div', { class: 'set-row' },
      el('div', {}, el('b', { text: 'Check for updates automatically' }),
        el('p', { class: 'muted', text: 'Checks GitHub on startup and every 6 hours, downloads in the background, and installs when you restart. Only the version check and download use the internet — your vault never leaves this PC.' })),
      el('span', { class: 'switch' }, el('input', { type: 'checkbox', checked: u.auto !== false, onchange: async (e) => { const r = await guard(() => api.setAutoUpdate(e.target.checked)); if (r) { UPD = r; toast(r.auto ? 'Automatic updates on' : 'Automatic updates off'); } } }), el('span', { class: 'slider' }))),
    el('p', { class: 'hint', text: 'Every update is verified against the checksum published with the GitHub release before it installs.' }));
}

function wireWindow() {
  const min = $('win-min'), max = $('win-max'), close = $('win-close');
  min.append(icon('min', 14)); max.append(icon('max', 12)); close.append(icon('x', 14));
  min.onclick = () => api.minimize();
  max.onclick = () => api.maximize();
  close.onclick = () => api.close();
  api.onWinState(({ maximized }) => { clear(max).append(icon(maximized ? 'restore' : 'max', 12)); });
}

function lockCard(subtitle) {
  return el('div', { class: 'lock-card' },
    el('span', { class: 'corner tl' }), el('span', { class: 'corner tr' }), el('span', { class: 'corner bl' }), el('span', { class: 'corner br' }),
    el('div', { class: 'lock-logo' }, bigLogo()),
    el('h1', { class: 'lock-title' }, 'EZ ', el('b', { text: 'VAULT' })),
    el('p', { class: 'lock-sub', text: subtitle }));
}

function showLock(st) {
  $('app').classList.add('hidden');
  const root = clear($('lock'));
  root.classList.remove('hidden');
  $('tb-status').textContent = '';
  const reasons = { update: 'Installing update…', idle: 'Locked after inactivity', minimize: 'Locked on minimize', system: 'Locked with your PC', manual: 'Vault locked', restored: 'Backup restored — unlock with its master password' };

  if (!st.exists) return showCreate(root);

  let needKey = !!st.needsSecretKey;
  const card = lockCard(needKey ? 'New PC detected' : (reasons[st.reason] || 'Enter your master password'));
  const pw = passwordInput({ id: 'unlock-pw', placeholder: 'Master password', autofocus: !needKey });
  const keyIn = el('input', { class: 'input mono', id: 'unlock-key', placeholder: 'Secret Key  (EZ1-XXXX-XXXX-…)', autocomplete: 'off', spellcheck: 'false' });
  const keyBlock = el('div', { class: 'key-block' },
    el('p', { class: 'key-help', text: 'This PC doesn’t have your Secret Key yet. Enter it from your Emergency Kit — you only need to do this once per PC.' }),
    keyIn);
  keyBlock.classList.toggle('hidden', !needKey);
  if (needKey) setTimeout(() => keyIn.focus(), 30);
  const err = el('div', { class: 'form-error' });
  const btn = el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, icon('lock', 15), el('span', { text: 'Unlock' }));
  card.append(el('form', { class: 'lock-form', onsubmit: async (e) => {
    e.preventDefault();
    if (!pw.input.value || (needKey && !keyIn.value.trim())) return;
    btn.disabled = true; btn.lastChild.textContent = 'Unlocking…'; err.textContent = '';
    try {
      const r = await api.unlock(pw.input.value, needKey ? keyIn.value : undefined);
      pw.input.value = ''; keyIn.value = '';
      if (r && r.secretKey) await showKit(r.secretKey, { upgraded: true });
      await enterApp();
    } catch (ex) {
      if (ex.code === 'NEEDS_SECRET_KEY') { needKey = true; keyBlock.classList.remove('hidden'); keyIn.focus(); }
      err.textContent = ex.message;
      card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
      if (ex.code === 'BAD_PASSWORD') pw.input.select();
    } finally { btn.disabled = false; btn.lastChild.textContent = 'Unlock'; }
  } }, keyBlock, pw.wrap, err, btn,
    el('button', { class: 'forgot-link', type: 'button', onclick: resetFlow }, 'Forgot your master password? Reset EZ Vault')));
  root.append(card, el('div', { class: 'lock-foot', text: 'Master password + Secret Key · AES-256-GCM · Nothing leaves your PC' }));
}

async function resetFlow() {
  const wipe = el('input', { type: 'checkbox', id: 'reset-wipe' });
  const content = el('div', { class: 'reset-box' },
    el('ul', { class: 'kit-tips' },
      el('li', { text: 'Your master password can’t be recovered — not by you, not by EZGGco. Resetting is the only way back in.' }),
      el('li', { text: 'All items in this vault will be gone and you’ll start with a new, empty vault.' }),
      el('li', { text: 'By default an encrypted copy of the old vault is kept in your backups. If you ever remember the password, you can restore it from Settings → Automatic backups.' })),
    el('label', { class: 'check danger-check', for: 'reset-wipe' }, wipe,
      el('span', {}, el('b', { text: 'Also delete all backups and saved Secret Keys on this PC.' }), ' Nothing can be recovered afterwards. (A second backup folder on a USB drive is not touched.)')));
  const typed = await modal({ title: 'Reset EZ Vault?', content, confirmText: 'Reset', danger: true, wide: true,
    input: { placeholder: 'Type RESET to confirm' } });
  if (typed === null) return;
  if (typed.trim().toUpperCase() !== 'RESET') return toast('Type RESET to confirm — nothing was changed', 'error', 3500);
  const r = await guard(() => api.resetVault({ wipeAll: wipe.checked }));
  if (!r) return;
  toast(r.keptCopy ? 'EZ Vault reset — an encrypted copy of the old vault was kept in backups' : 'EZ Vault reset — everything was deleted', 'success', 5000);
  showLock({ exists: false });
}

function showCreate(root) {
  const card = lockCard('Create your vault');
  const meterSlot = el('div', { class: 'meter-slot' }, strengthMeter(''));
  const pw = passwordInput({ id: 'new-pw', placeholder: 'Master password (12+ characters)', autofocus: true,
    oninput: (e) => clear(meterSlot).append(strengthMeter(e.target.value)) });
  const pw2 = passwordInput({ id: 'new-pw2', placeholder: 'Confirm master password' });
  const ack = el('input', { type: 'checkbox', id: 'ack' });
  const err = el('div', { class: 'form-error' });
  const btn = el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, icon('shield', 15), el('span', { text: 'Create vault' }));
  card.append(el('form', { class: 'lock-form', onsubmit: async (e) => {
    e.preventDefault();
    const a = pw.input.value, b = pw2.input.value;
    err.textContent = '';
    if ([...a].length < 12) return (err.textContent = 'Use at least 12 characters. A short phrase of 4+ random words works great.');
    if (window.EZStrength.estimate(a).score < 3) return (err.textContent = 'Too easy to guess — make it longer or less predictable.');
    if (a !== b) return (err.textContent = "Passwords don't match.");
    if (!ack.checked) return (err.textContent = 'Please confirm you understand it cannot be recovered.');
    btn.disabled = true; btn.lastChild.textContent = 'Creating…';
    try {
      const r = await api.create(a);
      pw.input.value = ''; pw2.input.value = '';
      await showKit(r.secretKey, { first: true });
      await enterApp();
      toast('Vault created — welcome to EZ Vault', 'success');
    } catch (ex) { err.textContent = ex.message; }
    finally { btn.disabled = false; btn.lastChild.textContent = 'Create vault'; }
  } },
    pw.wrap, meterSlot, bitsExplainer(), pw2.wrap,
    el('label', { class: 'check', for: 'ack' }, ack, el('span', { text: "I understand nobody — including EZGGco — can recover my master password or Secret Key." })),
    err, btn));
  root.append(card, el('div', { class: 'lock-foot', text: 'Encrypted locally with AES-256-GCM · Nothing leaves your PC' }));
}

/** Shows the Emergency Kit. On first creation the user must confirm they've saved it. */
async function showKit(secretKey, { first = false, upgraded = false } = {}) {
  const keyEl = el('div', { class: 'kit-key mono', text: secretKey });
  let saved = false;
  const confirmBox = el('input', { type: 'checkbox', id: 'kit-ack' });
  const content = el('div', { class: 'kit' },
    el('p', { class: 'modal-body', text: upgraded
      ? 'Your vault was upgraded with a Secret Key. Together with your master password it is needed to open your vault on any other PC.'
      : 'This is your Secret Key. It’s stored securely on this PC, but you need it plus your master password to open your vault on a new PC or after reinstalling Windows.' }),
    keyEl,
    el('div', { class: 'row-gap' },
      el('button', { class: 'btn btn-ghost', type: 'button', onclick: async () => { const p = await guard(() => api.saveKit(secretKey)); if (p) { saved = true; toast('Emergency Kit saved — print it, then delete the file', 'success', 4500); } } }, icon('download', 14), el('span', { text: 'Save Emergency Kit' })),
      el('button', { class: 'btn btn-ghost', type: 'button', onclick: async () => { await guard(() => api.copyGenerated(secretKey)); saved = true; toast('Secret Key copied · clipboard clears soon', 'success'); } }, icon('copy', 14), el('span', { text: 'Copy' }))),
    el('ul', { class: 'kit-tips' },
      el('li', { text: 'Print it or write it down, and keep it somewhere safe offline.' }),
      el('li', { text: 'Don’t store it in cloud storage, email or on this same PC next to your vault.' }),
      el('li', { text: 'Someone who steals your vault file can’t open it without this key — even if they guess your master password.' })),
    first ? el('label', { class: 'check', for: 'kit-ack' }, confirmBox, el('span', { text: 'I’ve saved my Emergency Kit somewhere safe.' })) : null);
  for (;;) {
    await modal({ title: 'Your Emergency Kit', content, confirmText: first || upgraded ? 'Continue' : 'Done', noCancel: first || upgraded, wide: true });
    if (!first || confirmBox.checked) break;
    toast(saved ? 'Tick the box to confirm you saved it' : 'Save or write down your Secret Key first', 'error', 3500);
  }
  keyEl.textContent = '';
}

function bigLogo() {
  const svg = el('svg', { viewBox: '0 0 64 64', class: 'logo-big', 'aria-hidden': 'true' });
  svg.append(el('path', { class: 'logo-shield', d: 'M32 4 L56 12 V30 C56 45 46 55 32 60 C18 55 8 45 8 30 V12 Z' }));
  svg.append(el('path', { class: 'logo-e', d: 'M16.07 21.7 L33.03 21.7 L29.04 25.19 L20.5 25.19 L20.05 26.86 L32.71 26.86 L28.45 30.29 L19.09 30.29 L18.57 32.19 L30.05 32.19 L24.91 36.26 L12 36.26 Z' }));
  svg.append(el('path', { class: 'logo-z', d: 'M34.23 21.7 L52 21.7 L39.26 32.19 L49.39 32.19 L44.57 36.26 L26.22 36.26 L40.59 25.19 L30.24 25.19 Z' }));
  return svg;
}

// ---------------------------------------------------------------- app shell
async function enterApp() {
  $('lock').classList.add('hidden');
  $('app').classList.remove('hidden');
  clear($('tb-status')).append(el('span', { class: 'dot' }), 'Unlocked');
  await refresh();
}

async function refresh() {
  const [entries, trash, folders, settings] = await Promise.all([api.list(), api.trash(), api.folders(), api.getSettings()]);
  S.entries = entries; S.trash = trash; S.folders = folders; S.settings = settings;
  if (S.selectedId && ![...entries, ...trash].some((e) => e.id === S.selectedId)) S.selectedId = null;
  renderSidebar();
  if (S.tool) renderTool(); else { renderList(); renderDetail(); }
}

function navItem(label, iconName, active, count, onClick, extra) {
  return el('div', { class: 'nav-item' + (active ? ' active' : ''), role: 'button', tabindex: '0', onclick: onClick,
    onkeydown: (e) => { if (e.key === 'Enter') onClick(); } },
    icon(iconName, 16), el('span', { class: 'nav-label', text: label }),
    count !== undefined ? el('span', { class: 'nav-count', text: String(count) }) : null, extra || null);
}

function renderSidebar() {
  const sb = clear($('sidebar'));
  const go = (view, folder = null) => async () => {
    if (!(await confirmLeaveEdit())) return;
    S.view = view; S.folder = folder; S.tool = null; S.mode = 'view'; S.dirty = false;
    showPanes(); renderSidebar(); renderList(); renderDetail();
  };
  const isV = (v, f) => !S.tool && S.view === v && (f === undefined || S.folder === f);
  const count = (fn) => S.entries.filter(fn).length;

  sb.append(...[
    el('div', { class: 'nav-section', text: 'Vault' }),
    navItem('All items', 'grid', isV('all'), S.entries.length, go('all')),
    navItem('Favorites', 'star', isV('fav'), count((e) => e.favorite), go('fav')),
    navItem('Logins', 'key', isV('login'), count((e) => e.type === 'login'), go('login')),
    navItem('API keys', 'code', isV('apikey'), count((e) => e.type === 'apikey'), go('apikey')),
    navItem('Secure notes', 'note', isV('note'), count((e) => e.type === 'note'), go('note')),
    navItem('Trash', 'trash', isV('trash'), S.trash.length, go('trash')),
    el('div', { class: 'nav-section nav-section-row' }, el('span', { text: 'Folders' }),
      iconBtn('plus', 'New folder', async () => {
        const name = await modal({ title: 'New folder', confirmText: 'Create', input: { placeholder: 'e.g. Tournaments' } });
        if (name) await guard(async () => { S.folders = await api.addFolder(name); renderSidebar(); });
      }, 'icon-btn-sm')),
    S.folders.map((f) => navItem(f, 'folder', isV('folder', f), count((e) => e.folder === f), go('folder', f),
      iconBtn('x', 'Delete folder', async (ev) => {
        ev.stopPropagation();
        if (!(await modal({ title: `Delete folder "${f}"?`, body: 'Items inside stay in your vault — they just lose this folder.', confirmText: 'Delete folder', danger: true }))) return;
        await guard(async () => { await api.removeFolder(f); if (S.folder === f) { S.view = 'all'; S.folder = null; } await refresh(); });
      }, 'icon-btn-sm nav-del'))),
    el('div', { class: 'nav-section', text: 'Tools' }),
    navItem('Generator', 'dice', S.tool === 'generator', undefined, () => openTool('generator')),
    navItem('Security', 'shield', S.tool === 'security', undefined, () => openTool('security')),
    navItem('Settings', 'gear', S.tool === 'settings', undefined, () => openTool('settings')),
    el('div', { class: 'sidebar-spacer' }),
    el('button', { class: 'btn btn-lock', onclick: () => api.lock(), title: 'Lock (Ctrl+L)' }, icon('lock', 15), el('span', { text: 'Lock vault' }), el('kbd', { text: 'Ctrl L' })),
    el('div', { class: 'sidebar-foot' }, el('span', { text: 'EZGGco' }), el('span', { class: 'muted', text: 'Free & open source' }))
  ].flat());
}

function showPanes() {
  const tool = !!S.tool;
  $('list-pane').classList.toggle('hidden', tool);
  $('detail-pane').classList.toggle('hidden', tool);
  $('tool-pane').classList.toggle('hidden', !tool);
}

// ---------------------------------------------------------------- list
function filtered() {
  const q = S.query.trim().toLowerCase();
  if (S.view === 'trash') return S.trash.filter((e) => !q || [e.title, e.username, e.url].some((v) => (v || '').toLowerCase().includes(q)));
  return S.entries
    .filter((e) => {
      if (S.view === 'fav' && !e.favorite) return false;
      if (['login', 'note', 'apikey'].includes(S.view) && e.type !== S.view) return false;
      if (S.view === 'folder' && e.folder !== S.folder) return false;
      if (!q) return true;
      return [e.title, e.username, e.url, e.folder].some((v) => (v || '').toLowerCase().includes(q));
    })
    .sort((a, b) => (b.favorite - a.favorite) || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

function viewTitle() {
  return { all: 'All items', fav: 'Favorites', login: 'Logins', note: 'Secure notes', apikey: 'API keys', trash: 'Trash', folder: S.folder }[S.view];
}

function renderList() {
  const pane = $('list-pane');
  const prevSearch = pane.querySelector('#search');
  const hadFocus = prevSearch && document.activeElement === prevSearch;
  clear(pane);
  const search = el('input', { class: 'input search-input', id: 'search', type: 'search', placeholder: 'Search vault…', value: S.query, autocomplete: 'off', spellcheck: 'false',
    oninput: (e) => { S.query = e.target.value; renderListItems(); } });
  pane.append(...[
    el('div', { class: 'list-head' },
      el('div', { class: 'search-wrap' }, icon('search', 15), search, el('kbd', { text: 'Ctrl F' })),
      el('button', { class: 'btn btn-primary btn-square', title: 'New item (Ctrl+N)', onclick: () => newItem() }, icon('plus', 18))),
    el('div', { class: 'list-title' }, el('span', { text: viewTitle() }),
      S.view === 'trash' && S.trash.length ? el('button', { class: 'link-btn', onclick: emptyTrash, text: 'Empty trash' }) : null,
      el('span', { class: 'muted', id: 'list-count' })),
    S.view === 'trash' ? el('div', { class: 'trash-note', text: 'Items are permanently deleted 30 days after you trash them.' }) : null,
    el('div', { class: 'list', id: 'list', role: 'listbox' })].filter(Boolean));
  if (hadFocus) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  renderListItems();
}

function renderListItems() {
  const list = clear($('list'));
  const items = filtered();
  $('list-count').textContent = String(items.length);
  if (!items.length) {
    list.append(el('div', { class: 'list-empty' },
      icon(S.query ? 'search' : 'key', 28),
      el('p', { text: S.query ? 'No matches' : S.view === 'trash' ? 'Trash is empty' : S.entries.length ? 'Nothing here yet' : 'Your vault is empty' }),
      !S.query && S.view !== 'trash' ? el('button', { class: 'btn btn-ghost', onclick: () => newItem() }, icon('plus', 14), el('span', { text: 'Add an item' })) : null,
      !S.query && !S.entries.length ? el('button', { class: 'btn btn-ghost', onclick: importCsv }, icon('upload', 14), el('span', { text: 'Import from browser (CSV)' })) : null));
    return;
  }
  for (const e of items) {
    const sub = e.deletedAt ? 'Deleted ' + fmtDate(e.deletedAt) : e.type === 'note' ? 'Secure note' : e.type === 'apikey' ? (e.username || e.url || 'API key') : (e.username || e.url || '—');
    list.append(el('div', { class: 'list-item' + (e.id === S.selectedId ? ' active' : ''), role: 'option', tabindex: '0', dataset: { id: e.id },
      onclick: () => selectItem(e.id), onkeydown: (ev) => listKey(ev, e.id) },
      avatar(e),
      el('div', { class: 'li-text' }, el('div', { class: 'li-title', text: e.title }), el('div', { class: 'li-sub', text: sub })),
      el('div', { class: 'li-badges' },
        e.reprompt ? el('span', { class: 'lockmark', title: 'Requires master password' }, icon('lock', 12)) : null,
        e.hasTotp ? el('span', { class: 'badge', text: '2FA' }) : null,
        e.favorite ? el('span', { class: 'fav' }, icon('star', 13)) : null)));
  }
}

function listKey(ev, id) {
  const items = filtered();
  const i = items.findIndex((x) => x.id === id);
  if (ev.key === 'Enter') selectItem(id);
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    const next = items[Math.max(0, Math.min(items.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { selectItem(next.id); $('list').querySelector(`[data-id="${next.id}"]`)?.focus(); }
  }
}

async function confirmLeaveEdit() {
  if (S.mode === 'view' || !S.dirty) return true;
  return modal({ title: 'Discard changes?', body: 'You have unsaved edits on this item.', confirmText: 'Discard', danger: true });
}

async function selectItem(id) {
  if (!(await confirmLeaveEdit())) return;
  S.selectedId = id; S.mode = 'view'; S.dirty = false;
  for (const n of $('list').querySelectorAll('.list-item')) n.classList.toggle('active', n.dataset.id === id);
  renderDetail();
}

async function newItem(type) {
  if (S.tool) { S.tool = null; showPanes(); renderSidebar(); renderList(); }
  if (!(await confirmLeaveEdit())) return;
  S.mode = 'new'; S.selectedId = null; S.dirty = false;
  for (const n of $('list').querySelectorAll('.list-item')) n.classList.remove('active');
  if (S.view === 'trash') { S.view = 'all'; renderSidebar(); renderList(); }
  const t = type || (['note', 'apikey'].includes(S.view) ? S.view : 'login');
  renderEditor({ type: t, folder: S.view === 'folder' ? S.folder : (t === 'apikey' && S.folders.includes('API Keys') ? 'API Keys' : ''), favorite: S.view === 'fav', reprompt: t === 'apikey' });
}

// ---------------------------------------------------------------- detail
function stopTotp() { clearInterval(S.totpTimer); S.totpTimer = null; }

async function renderDetail() {
  stopTotp();
  const pane = clear($('detail-pane'));
  if (S.mode === 'new') return;
  if (!S.selectedId) {
    pane.append(el('div', { class: 'detail-empty' }, bigLogo(),
      el('p', { text: 'Select an item, or create a new one.' }),
      el('div', { class: 'shortcuts' },
        el('span', {}, el('kbd', { text: 'Ctrl N' }), ' New'),
        el('span', {}, el('kbd', { text: 'Ctrl F' }), ' Search'),
        el('span', {}, el('kbd', { text: 'Ctrl L' }), ' Lock'))));
    return;
  }
  const e = await guard(() => api.get(S.selectedId));
  if (!e || e.id !== S.selectedId) return;
  if (S.mode === 'edit') {
    const full = await withItem(e.id, () => api.getForEdit(e.id));
    if (!full) { S.mode = 'view'; return renderDetail(); }
    return renderEditor(full);
  }

  const copy = (field, label, index) => async () => {
    const r = await withItem(e.id, () => api.copy(e.id, field, index));
    if (r) toast(r.clearsIn ? `${label} copied · clears in ${r.clearsIn}s` : `${label} copied`, 'success');
  };
  const secretLabel = e.type === 'apikey' ? 'API key' : 'Password';
  const fields = el('div', { class: 'fields' });

  if (e.deletedAt) {
    const left = Math.max(0, 30 - Math.floor((Date.now() - Date.parse(e.deletedAt)) / 864e5));
    fields.append(el('div', { class: 'trash-banner' }, icon('trash', 16),
      el('span', { text: `In trash since ${fmtDate(e.deletedAt)} · permanently deleted in ${left} day${left === 1 ? '' : 's'}` })));
  }
  if (e.locked) {
    fields.append(el('div', { class: 'protected' }, icon('lock', 18),
      el('div', {}, el('b', { text: 'Protected item' }), el('p', { class: 'muted', text: 'Secrets and notes in this item need your master password.' })),
      el('button', { class: 'btn btn-primary', onclick: async () => { const ok = await withItem(e.id, () => api.getForEdit(e.id)); if (ok) renderDetail(); } }, icon('key', 14), el('span', { text: 'Unlock item' }))));
  }
  if (e.type !== 'note') {
    if (e.username) fields.append(fieldRow(e.type === 'apikey' ? 'Key ID / account' : 'Username', el('span', { class: 'fv', text: e.username }), [iconBtn('copy', 'Copy', copy('username', e.type === 'apikey' ? 'Key ID' : 'Username'))]));
    if (e.hasPassword) {
      const val = el('span', { class: 'fv mono masked', text: '••••••••••••' });
      let shown = false;
      const eyeBtn = iconBtn('eye', 'Reveal', async () => {
        if (!shown) {
          const pw = await withItem(e.id, () => api.reveal(e.id, 'password'));
          if (pw === undefined) return;
          val.textContent = pw;
          setTimeout(() => { if (shown && val.isConnected) eyeBtn.click(); }, 30000); // auto-hide after 30s
        } else val.textContent = '••••••••••••';
        shown = !shown;
        val.classList.toggle('masked', !shown);
        clear(eyeBtn).append(icon(shown ? 'eyeOff' : 'eye'));
      });
      fields.append(fieldRow(secretLabel, el('div', { class: 'pw-block' }, val, e.type === 'login' && e.passwordScore ? meterFrom(e.passwordScore) : null),
        [eyeBtn, iconBtn('copy', 'Copy ' + secretLabel.toLowerCase(), copy('password', secretLabel))]));
    }
    if (e.hasTotp && !e.locked) {
      const code = el('span', { class: 'totp-code mono', text: '··· ···' });
      const ring = el('circle', { class: 'ring-fg', cx: 12, cy: 12, r: 9 });
      const secs = el('span', { class: 'totp-secs' });
      const ringSvg = el('svg', { viewBox: '0 0 24 24', class: 'ring', width: 26, height: 26 }, el('circle', { class: 'ring-bg', cx: 12, cy: 12, r: 9 }), ring);
      const tick = async () => {
        try {
          const t = await api.totp(e.id);
          if (!t) return;
          code.textContent = t.code.length === 6 ? t.code.slice(0, 3) + ' ' + t.code.slice(3) : t.code;
          code.classList.toggle('steam', !!t.steam);
          secs.textContent = t.remaining + 's';
          const c = 2 * Math.PI * 9;
          ring.style.strokeDasharray = String(c);
          ring.style.strokeDashoffset = String(c * (1 - t.remaining / t.period));
          code.classList.toggle('expiring', t.remaining <= 5);
        } catch { stopTotp(); code.textContent = '··· ···'; }
      };
      tick();
      S.totpTimer = setInterval(tick, 1000);
      const steam = e.totpKind === 'steam';
      fields.append(fieldRow(steam ? 'Steam Guard code' : '2FA code', el('div', { class: 'totp' + (steam ? ' totp-steam' : '') }, code, ringSvg, secs), [iconBtn('copy', 'Copy code', copy('totp', steam ? 'Steam Guard code' : '2FA code'))]));
    }
    if (e.url) {
      fields.append(fieldRow('Website', el('span', { class: 'fv link', text: e.url }),
        [iconBtn('external', 'Open in browser', () => guard(() => api.openUrl(e.url))), iconBtn('copy', 'Copy URL', copy('url', 'URL'))]));
    }
  }
  if (e.notes) fields.append(fieldRow(e.type === 'note' ? 'Note' : 'Notes', el('pre', { class: 'notes', text: e.notes }), [iconBtn('copy', 'Copy notes', copy('notes', 'Notes'))]));
  if (!fields.children.length) fields.append(el('p', { class: 'muted pad', text: 'This item has no fields yet. Hit Edit to add some.' }));

  const history = e.history.length && !e.locked
    ? el('details', { class: 'history' },
      el('summary', {}, icon('history', 14), el('span', { text: `${secretLabel} history (${e.history.length})` })),
      e.history.map((h, i) => {
        const v = el('span', { class: 'mono masked', text: '••••••••' });
        let on = false;
        return el('div', { class: 'history-row' }, v, el('span', { class: 'muted', text: fmtDate(h.changed) }),
          iconBtn('eye', 'Reveal', async () => {
            if (!on) { const p = await withItem(e.id, () => api.reveal(e.id, 'history', i)); if (p === undefined) return; v.textContent = p; } else v.textContent = '••••••••';
            on = !on; v.classList.toggle('masked', !on);
          }),
          iconBtn('copy', 'Copy', copy('history', 'Old password', i)));
      }))
    : null;

  pane.append(el('div', { class: 'detail' },
    el('div', { class: 'detail-head' },
      avatar(e, 'avatar-lg'),
      el('div', { class: 'detail-titles' },
        el('h2', { text: e.title }),
        el('div', { class: 'chips' },
          el('span', { class: 'chip', text: TYPE_META[e.type].label }),
          e.reprompt ? el('span', { class: 'chip chip-y' }, icon('lock', 11), 'Protected') : null,
          e.folder ? el('span', { class: 'chip' }, icon('folder', 12), e.folder) : null)),
      e.deletedAt ? el('div', { class: 'detail-actions' },
        el('button', { class: 'btn btn-primary', onclick: async () => {
          const ok = await withItem(e.id, () => api.restoreItem(e.id).then(() => true));
          if (!ok) return;
          toast('Item restored', 'success');
          await refresh();
        } }, icon('refresh', 14), el('span', { text: 'Restore' })),
        el('button', { class: 'btn btn-danger-ghost', onclick: async () => {
          if (!(await modal({ title: `Delete "${e.title}" forever?`, body: 'This can’t be undone. (Older automatic backups may still contain it until they expire.)', confirmText: 'Delete forever', danger: true }))) return;
          const ok = await withItem(e.id, () => api.purge(e.id).then(() => true));
          if (!ok) return;
          S.selectedId = null; toast('Permanently deleted'); await refresh();
        } }, icon('trash', 14), el('span', { text: 'Delete forever' }))) :
      el('div', { class: 'detail-actions' },
        iconBtn('star', e.favorite ? 'Unfavorite' : 'Favorite', async () => { await guard(() => api.toggleFavorite(e.id)); await refresh(); }, e.favorite ? 'is-fav' : ''),
        el('button', { class: 'btn btn-ghost', onclick: () => { S.mode = 'edit'; renderDetail(); } }, icon('edit', 14), el('span', { text: 'Edit' })),
        iconBtn('trash', 'Delete', async () => {
          const ok = await withItem(e.id, () => api.remove(e.id).then(() => true));
          if (!ok) return;
          S.selectedId = null;
          await refresh();
          toast(`"${e.title}" moved to trash`, 'info', 6000, { label: 'Undo', fn: async () => {
            await withItem(e.id, () => api.restoreItem(e.id));
            S.selectedId = e.id; await refresh();
          } });
        }, 'danger'))),
    fields,
    history,
    el('div', { class: 'meta' },
      el('span', { text: 'Created ' + fmtDate(e.created) }),
      el('span', { text: 'Updated ' + fmtDate(e.updated) }),
      e.hasPassword && e.passwordChanged ? el('span', { text: secretLabel + ' set ' + fmtDate(e.passwordChanged) }) : null)));
}

function fieldRow(label, valueNode, actions) {
  return el('div', { class: 'field' },
    el('div', { class: 'field-label', text: label }),
    el('div', { class: 'field-body' }, el('div', { class: 'field-value' }, valueNode), el('div', { class: 'field-actions' }, actions)));
}

// ---------------------------------------------------------------- editor
function renderEditor(e) {
  stopTotp();
  const pane = clear($('detail-pane'));
  const isNew = S.mode === 'new';
  let type = e.type || 'login';
  const markDirty = () => { S.dirty = true; };

  const title = el('input', { class: 'input', id: 'f-title', value: e.title || '', placeholder: 'e.g. Steam, FACEIT, OpenAI', maxlength: 200, oninput: markDirty });
  const username = el('input', { class: 'input', id: 'f-user', value: e.username || '', autocomplete: 'off', spellcheck: 'false', oninput: markDirty });
  const meterSlot = el('div', { class: 'meter-slot' }, strengthMeter(e.password || ''));
  const pw = passwordInput({ id: 'f-pass', value: e.password || '', oninput: (ev) => { markDirty(); clear(meterSlot).append(strengthMeter(ev.target.value)); } });
  const genBtn = el('button', { class: 'btn btn-ghost btn-gen', type: 'button', title: 'Generate a strong password', onclick: async () => {
    const g = await guard(() => api.generate(S.settings.generator));
    if (!g) return;
    pw.input.value = g.value; pw.input.type = 'text'; markDirty();
    clear(meterSlot).append(meterFromBits(g.bits));
  } }, icon('dice', 15), el('span', { text: 'Generate' }));
  const url = el('input', { class: 'input', id: 'f-url', value: e.url || '', placeholder: 'https://', spellcheck: 'false', oninput: markDirty });
  const totpIn = el('input', { class: 'input mono', id: 'f-totp', type: 'password', value: e.totp || '', placeholder: 'Base32 secret or otpauth:// link (optional)', spellcheck: 'false', autocomplete: 'off', oninput: markDirty });
  const folder = el('select', { class: 'input', id: 'f-folder', onchange: markDirty },
    el('option', { value: '', text: 'No folder' }),
    S.folders.map((f) => el('option', { value: f, text: f, selected: f === e.folder ? 'selected' : null })));
  const notes = el('textarea', { class: 'input', id: 'f-notes', rows: 5, oninput: markDirty });
  notes.value = e.notes || '';
  const fav = el('input', { type: 'checkbox', id: 'f-fav', checked: !!e.favorite, onchange: markDirty });
  const reprompt = el('input', { type: 'checkbox', id: 'f-reprompt', checked: !!e.reprompt, onchange: markDirty });

  const userLabel = el('label', { class: 'form-label' });
  const pwLabel = el('label', { class: 'form-label' });
  const notesLabel = el('label', { class: 'form-label' });
  const userRow = el('div', { class: 'form-row' }, userLabel, username);
  const pwRow = el('div', { class: 'form-row' }, pwLabel, el('div', {}, el('div', { class: 'row-gap' }, pw.wrap, genBtn), meterSlot));
  const urlRow = formRow('Website', url);
  let totpKind = /^steam:\/\//i.test(e.totp || '') ? 'steam' : 'totp';
  const totpHint = el('div', { class: 'hint' });
  const totpSeg = el('div', { class: 'seg seg-sm' }, [['totp', 'Authenticator'], ['steam', 'Steam Guard']].map(([k, label]) =>
    el('button', { type: 'button', class: 'seg-btn' + (k === totpKind ? ' active' : ''), dataset: { k }, onclick: (ev) => {
      totpKind = k; markDirty();
      totpSeg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.k === k));
      applyTotpKind(); ev.currentTarget.blur();
    } }, label)));
  const applyTotpKind = () => {
    const steam = totpKind === 'steam';
    totpIn.placeholder = steam ? 'shared_secret, or paste the whole .maFile' : 'Base32 secret or otpauth:// link (optional)';
    totpHint.textContent = steam
      ? 'From Steam Desktop Authenticator: open your .maFile and paste the shared_secret (or the whole file). Gives you the same 5-character codes as the Steam app.'
      : 'Paste the setup key from a site\'s "authenticator app" screen to get live 2FA codes here.';
  };
  applyTotpKind();
  const totpRow = el('div', { class: 'form-row' },
    el('div', { class: 'label-row' }, el('label', { class: 'form-label', text: '2FA' }), totpSeg), totpIn, totpHint);

  const applyType = () => {
    const isNote = type === 'note', isKey = type === 'apikey';
    userRow.classList.toggle('hidden', isNote);
    pwRow.classList.toggle('hidden', isNote);
    urlRow.classList.toggle('hidden', isNote);
    totpRow.classList.toggle('hidden', isNote || isKey);
    meterSlot.classList.toggle('hidden', isKey);
    genBtn.classList.toggle('hidden', isKey); // API keys come from the service — never generate over one
    userLabel.textContent = isKey ? 'Key ID / account (optional)' : 'Username';
    username.placeholder = isKey ? 'e.g. key name, project or account email' : 'Username or email';
    pwLabel.textContent = isKey ? 'API key / secret' : 'Password';
    pw.input.placeholder = isKey ? 'sk-…' : 'Password';
    notesLabel.textContent = isNote ? 'Note' : 'Notes';
    notes.placeholder = isNote ? 'Write your secure note…' : isKey ? 'Scopes, expiry date, where it’s used… (optional)' : 'Notes (optional)';
  };

  const seg = el('div', { class: 'seg' },
    ['login', 'apikey', 'note'].map((t) => el('button', { type: 'button', class: 'seg-btn' + (t === type ? ' active' : ''), dataset: { t },
      onclick: (ev) => {
        type = t; markDirty();
        seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.t === t));
        if (t === 'apikey' && isNew) reprompt.checked = true;
        applyType();
        ev.currentTarget.blur();
      } }, icon(TYPE_META[t].icon, 14), TYPE_META[t].label)));
  applyType();

  const save = async () => {
    const entry = {
      id: isNew ? undefined : e.id, type, title: title.value, username: type === 'note' ? '' : username.value,
      password: type === 'note' ? '' : pw.input.value, url: type === 'note' ? '' : url.value,
      totp: type === 'login' ? totpIn.value : '', totpKind, folder: folder.value, notes: notes.value, favorite: fav.checked, reprompt: reprompt.checked
    };
    if (!entry.title.trim()) { title.focus(); return toast('Give it a name first', 'error'); }
    const id = await withItem(e.id, () => api.save(entry));
    if (!id) return;
    pw.input.value = ''; totpIn.value = '';
    S.selectedId = id; S.mode = 'view'; S.dirty = false;
    toast(isNew ? 'Item added' : 'Changes saved', 'success');
    await refresh();
    $('list').querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  const cancel = async () => {
    if (!(await confirmLeaveEdit())) return;
    S.dirty = false; S.mode = 'view';
    renderDetail();
  };

  const form = el('form', { class: 'editor', id: 'editor', onsubmit: (ev) => { ev.preventDefault(); save(); } },
    el('div', { class: 'editor-head' }, el('h2', { text: isNew ? 'New item' : 'Edit item' }), seg),
    formRow('Name', title),
    userRow, pwRow, urlRow, totpRow,
    formRow('Folder', folder),
    el('div', { class: 'form-row' }, notesLabel, notes),
    el('label', { class: 'check', for: 'f-reprompt' }, reprompt, el('span', {}, el('b', { text: 'Require master password' }), ' to view, copy or edit this item. Recommended for API keys, bank logins and recovery codes.')),
    el('label', { class: 'check', for: 'f-fav' }, fav, el('span', { text: 'Favorite (pins to the top)' })),
    el('div', { class: 'editor-actions' },
      el('button', { class: 'btn btn-ghost', type: 'button', onclick: cancel }, 'Cancel', el('kbd', { text: 'Esc' })),
      el('button', { class: 'btn btn-primary', type: 'submit' }, icon('check', 15), el('span', { text: isNew ? 'Add item' : 'Save' }), el('kbd', { text: 'Ctrl S' }))));
  form._save = save; form._cancel = cancel;
  pane.append(form);
  setTimeout(() => title.focus(), 30);
}

function formRow(label, control, hint) {
  return el('div', { class: 'form-row' }, el('label', { class: 'form-label', text: label }), control, hint ? el('div', { class: 'hint', text: hint }) : null);
}

// ---------------------------------------------------------------- tools
async function openTool(name) {
  if (!(await confirmLeaveEdit())) return;
  S.mode = 'view'; S.dirty = false; S.tool = name;
  stopTotp();
  showPanes(); renderSidebar(); renderTool();
}

function renderTool() {
  showPanes();
  if (S.tool === 'generator') return renderGenerator();
  if (S.tool === 'security') return renderSecurity();
  if (S.tool === 'settings') return renderSettings();
}

function toolHeader(iconName, title, sub) {
  return el('div', { class: 'tool-head' }, el('div', { class: 'tool-icon' }, icon(iconName, 22)),
    el('div', {}, el('h2', { text: title }), el('p', { class: 'muted', text: sub })));
}

async function renderGenerator() {
  const pane = clear($('tool-pane'));
  const opts = { mode: 'password', length: 24, words: 6, separator: '-', capitalize: true, number: true, ...S.settings.generator };
  const out = el('div', { class: 'gen-out mono' });
  const meterSlot = el('div', { class: 'meter-slot' });
  let current = '';
  const colorize = (pw) => {
    clear(out);
    for (const ch of pw) out.append(el('span', { class: /[0-9]/.test(ch) ? 'c-d' : /[A-Za-z]/.test(ch) ? '' : 'c-s', text: ch }));
  };
  const regen = async () => {
    const g = await guard(() => api.generate(opts));
    if (!g) return;
    current = g.value;
    colorize(current);
    clear(meterSlot).append(meterFromBits(g.bits));
  };
  const numberRow = (label, key, min, max, rangeMax) => {
    const num = el('input', { class: 'input num', type: 'number', min, max, value: opts[key] });
    const range = el('input', { class: 'range', type: 'range', min, max: rangeMax, value: Math.min(rangeMax, opts[key]) });
    const setVal = (v) => {
      const n = Math.max(min, Math.min(max, parseInt(v, 10) || min));
      opts[key] = n; num.value = n; range.value = Math.min(rangeMax, n); regen();
    };
    range.oninput = (e) => setVal(e.target.value);
    num.onchange = (e) => setVal(e.target.value);
    return el('div', { class: 'len-row' }, el('b', { text: label }), range, num);
  };
  const toggle = (key, label, sample, guardTypes = false) => el('label', { class: 'toggle-row' },
    el('span', {}, el('b', { text: label }), sample ? el('span', { class: 'muted mono', text: '  ' + sample }) : null),
    el('span', { class: 'switch' },
      el('input', { type: 'checkbox', checked: opts[key], onchange: (e) => {
        opts[key] = e.target.checked;
        if (guardTypes && !['upper', 'lower', 'digits', 'symbols'].some((k) => opts[k])) { opts[key] = true; e.target.checked = true; return toast('Keep at least one character type on', 'error'); }
        regen();
      } }), el('span', { class: 'slider' })));

  const passwordOpts = el('div', {},
    numberRow('Length', 'length', 8, 128, 64),
    toggle('upper', 'Uppercase', 'A–Z', true),
    toggle('lower', 'Lowercase', 'a–z', true),
    toggle('digits', 'Numbers', '0–9', true),
    toggle('symbols', 'Symbols', '!@#$%^&*', true),
    toggle('avoidAmbiguous', 'Avoid look-alikes', 'O 0 l 1 |'));
  const sepLabels = { '-': 'Dash  -', '.': 'Dot  .', '_': 'Underscore  _', ' ': 'Space', ',': 'Comma  ,', '': 'None' };
  const sepSel = el('select', { class: 'input sep-select', onchange: (e) => { opts.separator = e.target.value; regen(); } },
    Object.entries(sepLabels).map(([v, l]) => el('option', { value: v, text: l, selected: v === opts.separator ? 'selected' : null })));
  const phraseOpts = el('div', {},
    numberRow('Words', 'words', 3, 12, 12),
    el('div', { class: 'toggle-row' }, el('b', { text: 'Separator' }), sepSel),
    toggle('capitalize', 'Capitalize words', 'Tundra-Blaster'),
    toggle('number', 'Add a number', 'Ozone7'),
    el('p', { class: 'hint', text: 'Passphrases are easy to type and remember — perfect for your master password, Windows login or consoles. 6 words ≈ 72+ bits.' }));

  const applyMode = () => {
    passwordOpts.classList.toggle('hidden', opts.mode === 'passphrase');
    phraseOpts.classList.toggle('hidden', opts.mode !== 'passphrase');
    out.classList.toggle('gen-phrase', opts.mode === 'passphrase');
  };
  const modeSeg = el('div', { class: 'seg' }, [['password', 'Password', 'key'], ['passphrase', 'Passphrase', 'note']].map(([m, label, ic]) =>
    el('button', { type: 'button', class: 'seg-btn' + (opts.mode === m ? ' active' : ''), dataset: { m }, onclick: (ev) => {
      opts.mode = m;
      modeSeg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.m === m));
      applyMode(); regen(); ev.currentTarget.blur();
    } }, icon(ic, 14), label)));
  applyMode();

  pane.append(
    el('div', { class: 'tool-head-row' }, toolHeader('dice', 'Generator', 'Cryptographically random, generated on your PC.'), modeSeg),
    el('div', { class: 'card gen-card' },
      out,
      el('div', { class: 'gen-actions' },
        meterSlot,
        el('div', { class: 'row-gap' },
          el('button', { class: 'btn btn-ghost', onclick: regen }, icon('refresh', 15), el('span', { text: 'Regenerate' })),
          el('button', { class: 'btn btn-primary', onclick: async () => {
            const r = await guard(() => api.copyGenerated(current));
            if (r) toast(r.clearsIn ? `Copied · clears in ${r.clearsIn}s` : 'Copied', 'success');
          } }, icon('copy', 15), el('span', { text: 'Copy' }))))),
    el('div', { class: 'card' },
      passwordOpts, phraseOpts,
      el('div', { class: 'card-foot' },
        el('button', { class: 'btn btn-ghost', onclick: async () => {
          S.settings = await guard(() => api.setSettings({ generator: opts })) || S.settings;
          toast('Saved — the editor\'s Generate button will use these settings', 'success');
        } }, icon('check', 14), el('span', { text: 'Use these settings when generating in the editor' })))));
  regen();
}

async function emptyTrash() {
  if (!(await modal({ title: 'Empty trash?', body: `Permanently delete ${S.trash.length} item${S.trash.length === 1 ? '' : 's'}. This can’t be undone.`, confirmText: 'Empty trash', danger: true }))) return;
  const n = await guard(() => withReauth((pw) => api.emptyTrash(pw), 'Some trashed items are protected. Enter your master password to delete them.'));
  if (n === undefined) return;
  S.selectedId = null;
  toast(`Deleted ${n} item${n === 1 ? '' : 's'} forever`);
  await refresh();
}

async function renderSecurity() {
  const pane = clear($('tool-pane'));
  pane.append(toolHeader('shield', 'Security check', 'Spots weak, reused and stale passwords. Runs entirely offline.'));
  const a = await guard(() => api.audit());
  if (!a) return;
  const grade = a.total === 0 ? '—' : a.score >= 90 ? 'S' : a.score >= 75 ? 'A' : a.score >= 55 ? 'B' : a.score >= 35 ? 'C' : 'D';
  const C = 2 * Math.PI * 52;
  const fg = el('circle', { class: 'score-fg', cx: 60, cy: 60, r: 52 });
  fg.style.strokeDasharray = String(C);
  fg.style.strokeDashoffset = String(C * (1 - (a.total ? a.score : 0) / 100));
  const ring = el('svg', { viewBox: '0 0 120 120', class: 'score-ring' }, el('circle', { class: 'score-bg', cx: 60, cy: 60, r: 52 }), fg);

  const openItem = (id) => async () => {
    S.tool = null; S.view = 'all'; S.folder = null; S.query = '';
    showPanes(); renderSidebar(); renderList();
    await selectItem(id);
  };
  const issueList = (items, sub) => el('div', { class: 'issues' }, items.map((x) => el('div', { class: 'issue', role: 'button', tabindex: '0', onclick: openItem(x.id) },
    el('div', { class: 'avatar avatar-sm' }, initials(x.title)),
    el('div', { class: 'li-text' }, el('div', { class: 'li-title', text: x.title }), el('div', { class: 'li-sub', text: sub(x) })),
    icon('external', 14))));
  const stat = (n, label, kind) => el('div', { class: 'stat ' + (n ? kind : 'ok') }, el('div', { class: 'stat-n', text: String(n) }), el('div', { class: 'stat-l', text: label }));

  pane.append(el('div', { class: 'card sec-hero' },
    el('div', { class: 'ring-wrap' }, ring, el('div', { class: 'ring-center' }, el('div', { class: 'grade', text: grade }), el('div', { class: 'muted', text: a.total ? a.score + '/100' : 'No logins' }))),
    el('div', { class: 'stats' },
      stat(a.weak.length, 'Weak', 'bad'),
      stat(a.reusedCount, 'Reused', 'bad'),
      stat(a.old.length, 'Over 1 year old', 'warn'),
      stat(a.no2fa, 'Without 2FA', 'warn'))));

  if (a.clipboard && (a.clipboard.history || a.clipboard.cloud)) {
    pane.append(el('div', { class: 'card warn-card' }, el('h3', {}, icon('alert', 16), ' Windows clipboard history is on'),
      el('p', { class: 'muted', text: `Windows ${a.clipboard.cloud ? 'saves and syncs to the cloud' : 'saves'} everything you copy (Win+V) — including passwords copied from EZ Vault, even after EZ Vault clears the clipboard. Turn it off for maximum safety.` }),
      el('button', { class: 'btn btn-ghost', onclick: () => api.openClipboardSettings() }, icon('gear', 14), el('span', { text: 'Open clipboard settings' }))));
  }
  if (a.unprotectedKeys && a.unprotectedKeys.length) {
    pane.append(el('div', { class: 'card' }, el('h3', {}, icon('code', 16), ' API keys without master password protection'),
      el('p', { class: 'muted', text: 'Turn on "Require master password" for these so nobody can copy them from an unlocked PC.' }),
      issueList(a.unprotectedKeys, (x) => x.username || 'API key')));
  }
  if (a.weak.length) pane.append(el('div', { class: 'card' }, el('h3', {}, icon('alert', 16), ' Weak passwords'), issueList(a.weak, (x) => `${x.label}${x.username ? ' · ' + x.username : ''}`)));
  if (a.reused.length) {
    pane.append(el('div', { class: 'card' }, el('h3', {}, icon('copy', 16), ' Reused passwords'),
      el('p', { class: 'muted', text: 'If one of these sites gets breached, every account sharing the password is exposed.' }),
      a.reused.map((g, i) => el('div', { class: 'reuse-group' }, el('div', { class: 'reuse-label', text: `Group ${i + 1} · ${g.length} accounts` }), issueList(g, (x) => x.username || '—')))));
  }
  if (a.old.length) pane.append(el('div', { class: 'card' }, el('h3', {}, icon('clock', 16), ' Not changed in over a year'), issueList(a.old, (x) => 'Last changed ' + fmtDate(x.changed))));
  if (a.total && !a.weak.length && !a.reused.length && !a.old.length) {
    pane.append(el('div', { class: 'card all-good' }, icon('check', 22), el('div', {}, el('b', { text: 'Clean sheet.' }), el('p', { class: 'muted', text: 'No weak, reused or stale passwords. GG.' }))));
  }
}

async function renderSettings() {
  const pane = clear($('tool-pane'));
  const s = S.settings;
  const info = await api.info().catch(() => ({ version: '1.0.0' }));
  const st = await api.status().catch(() => ({}));
  const binfo = await api.backupInfo().catch(() => null);
  UPD = await api.updateStatus().catch(() => UPD);
  const set = async (patch, msg) => {
    const r = await guard(() => withReauth((pw) => api.setSettings(patch, pw), 'This change lowers your protection. Enter your master password to confirm.'));
    if (r) { S.settings = r; if (msg) toast(msg, 'success'); }
    renderSettings();
  };
  const sw = (checked, onchange) => el('span', { class: 'switch' }, el('input', { type: 'checkbox', checked, onchange }), el('span', { class: 'slider' }));
  const numIn = (value, min, max, key, unit) => el('div', { class: 'num-wrap' },
    el('input', { class: 'input num', type: 'number', min, max, value, onchange: (e) => set({ [key]: e.target.value }, 'Saved') }),
    el('span', { class: 'muted', text: unit }));
  const row = (title, desc, control) => el('div', { class: 'set-row' }, el('div', {}, el('b', { text: title }), el('p', { class: 'muted', text: desc })), control);

  const cur = passwordInput({ id: 'm-cur', placeholder: 'Current master password' });
  const mMeter = el('div', { class: 'meter-slot' }, strengthMeter(''));
  const nw = passwordInput({ id: 'm-new', placeholder: 'New master password (12+ characters)', oninput: (e) => clear(mMeter).append(strengthMeter(e.target.value)) });
  const nw2 = passwordInput({ id: 'm-new2', placeholder: 'Confirm new master password' });
  const mErr = el('div', { class: 'form-error' });

  pane.append(...[
    toolHeader('gear', 'Settings', 'Everything is stored inside your encrypted vault.'),
    el('div', { class: 'card protection' }, el('h3', {}, icon('shield', 16), ' Your protection'),
      el('ul', { class: 'prot-list' },
        el('li', {}, icon('check', 14), el('span', {}, el('b', { text: 'Two-secret encryption: ' }), 'master password + 160-bit Secret Key → AES-256-GCM')),
        el('li', {}, icon('check', 14), el('span', {}, el('b', { text: 'Memory-hard key stretching: ' }), 'scrypt, 256 MB per guess')),
        el('li', { class: st.dpapi === false ? 'bad' : '' }, icon(st.dpapi === false ? 'alert' : 'check', 14), el('span', {}, el('b', { text: 'Secret Key on this PC: ' }), st.dpapi === false ? 'not protected by Windows (DPAPI unavailable)' : 'locked to your Windows account (DPAPI)')),
        el('li', {}, icon('check', 14), el('span', {}, el('b', { text: 'Your vault never touches the network: ' }), 'the app window is blocked from the internet; only the update checker talks to GitHub')))),
    el('div', { class: 'card' }, el('h3', {}, icon('key', 16), ' Emergency Kit'),
      row('Secret Key', 'Needed with your master password to open your vault on a new PC or after reinstalling Windows.',
        el('button', { class: 'btn btn-ghost', onclick: async () => {
          const pw = await askMaster('Enter your master password to view your Secret Key.');
          if (!pw) return;
          const k = await guard(() => api.emergencyKit(pw));
          if (k) await showKit(k);
        } }, icon('eye', 14), el('span', { text: 'View Emergency Kit' })))),
    binfo ? backupsCard(binfo, row, numIn) : null,
    el('div', { class: 'card' }, el('h3', {}, icon('lock', 16), ' Locking & clipboard'),
      row('Auto-lock', 'Lock after this many minutes without using EZ Vault. 0 = never (not recommended).', numIn(s.autoLockMinutes, 0, 240, 'autoLockMinutes', 'min')),
      row('Clear clipboard', 'Wipe copied passwords and codes from the clipboard after this long. 0 = never.', numIn(s.clipboardSeconds, 0, 600, 'clipboardSeconds', 'sec')),
      row('Lock on minimize', 'Lock the vault as soon as you minimize the window — handy before tabbing into a match.', sw(s.lockOnMinimize, (e) => set({ lockOnMinimize: e.target.checked }, 'Saved'))),
      el('p', { class: 'hint', text: 'Turning protections down asks for your master password.' })),
    el('div', { class: 'card' }, el('h3', {}, icon('stream', 16), ' Streamer mode'),
      row('Hide from screen capture', 'EZ Vault shows up blank in OBS, Discord screen share and screenshots, so you never leak a password on stream.', sw(s.streamerMode, (e) => set({ streamerMode: e.target.checked }, e.target.checked ? 'Streamer mode on' : 'Streamer mode off'))),
      el('p', { class: 'hint', text: 'The lock screen is always hidden from capture.' })),
    el('div', { class: 'card' }, el('h3', {}, icon('key', 16), ' Change master password'),
      el('form', { class: 'master-form', onsubmit: async (e) => {
        e.preventDefault(); mErr.textContent = '';
        if (nw.input.value !== nw2.input.value) return (mErr.textContent = "New passwords don't match.");
        if ([...nw.input.value].length < 12 || window.EZStrength.estimate(nw.input.value).score < 3) return (mErr.textContent = 'Pick a stronger master password (12+ characters, hard to guess).');
        const btn = e.submitter; btn.disabled = true;
        try {
          await api.changeMaster(cur.input.value, nw.input.value);
          [cur, nw, nw2].forEach((x) => { x.input.value = ''; });
          toast('Master password changed', 'success');
        } catch (ex) { mErr.textContent = ex.message; }
        finally { btn.disabled = false; }
      } }, cur.wrap, nw.wrap, mMeter, bitsExplainer(), nw2.wrap, mErr, el('button', { class: 'btn btn-primary', type: 'submit', text: 'Change master password' }))),
    el('div', { class: 'card' }, el('h3', {}, icon('download', 16), ' Import & backup'),
      row('Import from a browser or another manager', 'CSV exports from Chrome, Edge, Brave, Firefox, Bitwarden and most password managers.',
        el('button', { class: 'btn btn-ghost', onclick: importCsv }, icon('upload', 14), el('span', { text: 'Import CSV' }))),
      row('Encrypted backup', 'Saves a copy of your locked vault. Restoring needs your master password and Secret Key.',
        el('button', { class: 'btn btn-ghost', onclick: async () => { const p = await guard(() => api.backup()); if (p) toast('Backup saved', 'success'); } }, icon('download', 14), el('span', { text: 'Save backup' }))),
      row('Export unencrypted CSV', 'Anyone with this file can read every password. Requires your master password.',
        el('button', { class: 'btn btn-danger-ghost', onclick: async () => {
          if (!(await modal({ title: 'Export unencrypted passwords?', body: 'The CSV file will contain every password and API key in plain text. Only do this to move to another manager, and delete the file afterwards.', confirmText: 'Continue', danger: true }))) return;
          const pw = await askMaster('Enter your master password to export.');
          if (!pw) return;
          const p = await guard(() => api.exportCsv(pw)); if (p) toast('Exported — delete the file when done', 'success', 4500);
        } }, icon('alert', 14), el('span', { text: 'Export CSV' }))),
      row('Vault file', 'Your encrypted vault lives in your AppData folder.',
        el('button', { class: 'btn btn-ghost', onclick: () => api.revealFolder() }, icon('folder', 14), el('span', { text: 'Show in folder' })))),
    (() => { const c = el('div', { class: 'card', id: 'upd-card' }); renderUpdateCard(c); return c; })(),
    el('div', { class: 'card' }, el('h3', {}, icon('shield', 16), ' Report a security issue'),
      row('Found a vulnerability?', 'Report it privately to EZGGco on GitHub. Reports are only visible to the EZ Vault team — please don’t post security issues publicly or include any of your real passwords.',
        el('button', { class: 'btn btn-ghost', onclick: () => guard(() => api.reportSecurity()) }, icon('external', 14), el('span', { text: 'Report privately' })))),
    el('div', { class: 'card about' },
      bigLogo(),
      el('div', {},
        el('b', { text: `EZ Vault ${info.version}` }),
        el('p', { class: 'muted', text: 'Made by EZGGco. Free and open source. Your vault never leaves this PC.' })))].filter(Boolean));
}

function backupsCard(b, row, numIn) {
  const fmt = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const failed = (b.last && b.last.results || []).filter((r) => !r.ok);
  const all = [...b.local.map((x) => ({ ...x, where: 'This PC' })), ...b.extra.map((x) => ({ ...x, where: 'Second copy' }))]
    .sort((x, y) => y.date.localeCompare(x.date)).slice(0, 30);
  const restoreRow = (x) => el('div', { class: 'backup-row' },
    icon(x.kind === 'auto' ? 'clock' : 'history', 14),
    el('span', { class: 'b-date', text: fmt(x.date) }),
    el('span', { class: 'muted', text: x.kind === 'pre-restore' ? 'Before a restore' : x.kind === 'pre-reset' ? 'Before a reset' : x.where }),
    el('button', { class: 'btn btn-ghost btn-sm', onclick: () => restoreFlow(x.path, fmt(x.date)) }, 'Restore'));
  return el('div', { class: 'card' }, el('h3', {}, icon('download', 16), ' Automatic backups'),
    el('p', { class: 'muted card-sub', text: `An encrypted snapshot is saved whenever your vault changes (at most once an hour). Everything from the last 48 hours is kept, then one per day for ${b.keepDays} days.` }),
    failed.length ? el('div', { class: 'backup-warn' }, icon('alert', 14), el('span', { text: `Last backup to ${failed.map((f) => f.dir).join(', ')} failed — is the drive plugged in?` })) : null,
    row('On this PC', b.localDir, el('button', { class: 'btn btn-ghost', onclick: () => api.openBackupFolder('local') }, icon('folder', 14), el('span', { text: 'Open' }))),
    row('Second copy', b.extraDir || 'Not set. Point this at a USB stick or another drive so one dead SSD can’t take your passwords with it.',
      el('div', { class: 'row-gap' },
        el('button', { class: 'btn ' + (b.extraDir ? 'btn-ghost' : 'btn-primary'), onclick: async () => {
          const d = await guard(() => api.chooseBackupDir());
          if (d) { toast('Second backup location set — first copy written', 'success'); S.settings = await api.getSettings(); renderSettings(); }
        } }, icon('folder', 14), el('span', { text: b.extraDir ? 'Change' : 'Choose folder' })),
        b.extraDir ? iconBtn('x', 'Stop backing up here', async () => {
          const r = await guard(() => withReauth((pw) => api.setSettings({ backupDir: '' }, pw), 'Removing a backup location lowers your protection. Enter your master password to confirm.'));
          if (r) { S.settings = r; toast('Second backup location removed'); renderSettings(); }
        }) : null)),
    row('Keep daily backups for', 'Older backups are deleted automatically.', numIn(b.keepDays, 3, 365, 'backupKeepDays', 'days')),
    el('details', { class: 'history backups-list' },
      el('summary', {}, icon('history', 14), el('span', { text: `Restore a backup (${all.length})` })),
      all.length ? all.map(restoreRow) : el('p', { class: 'muted pad', text: 'No backups yet.' }),
      el('div', { class: 'backup-foot' },
        el('button', { class: 'btn btn-ghost', onclick: async () => {
          const f = await guard(() => api.pickBackupFile());
          if (f) restoreFlow(f, f.split(/[\\/]/).pop());
        } }, icon('upload', 14), el('span', { text: 'Restore from file…' })),
        el('button', { class: 'btn btn-ghost', onclick: async () => { const r = await guard(() => api.backupNow()); if (r) { toast('Backup saved', 'success'); renderSettings(); } } }, icon('download', 14), el('span', { text: 'Back up now' })))));
}

async function restoreFlow(file, label) {
  if (!(await modal({ title: 'Restore this backup?', body: `Your vault will be replaced with the backup from ${label}. Your current vault is saved first as a "before restore" backup, so you can undo this. EZ Vault will lock afterwards.`, confirmText: 'Continue' }))) return;
  const pw = await askMaster('Enter the master password you were using when this backup was made.');
  if (!pw) return;
  const r = await guard(() => api.restoreBackup(file, pw));
  if (r) toast('Backup restored — unlock to continue', 'success', 4000);
}

async function importCsv() {
  const n = await guard(() => api.importCsv());
  if (n === null || n === undefined) return;
  toast(`Imported ${n} item${n === 1 ? '' : 's'}`, 'success');
  await refresh();
  if (n) toast('Now delete the CSV file you imported from — it isn\'t encrypted.', 'info', 6000);
}

// ---------------------------------------------------------------- keyboard
function onGlobalKey(e) {
  if ($('modal-root').firstChild) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if ($('app').classList.contains('hidden')) return;
  const k = e.key.toLowerCase();
  if (ctrl && k === 'l') { e.preventDefault(); api.lock(); }
  else if (ctrl && k === 'n') { e.preventDefault(); newItem(); }
  else if (ctrl && k === 'f') {
    e.preventDefault();
    if (S.tool) { S.tool = null; showPanes(); renderSidebar(); renderList(); renderDetail(); }
    $('search')?.focus(); $('search')?.select();
  } else if (ctrl && k === 's' && $('editor')) { e.preventDefault(); $('editor')._save(); }
  else if (e.key === 'Escape' && $('editor')) { e.preventDefault(); $('editor')._cancel(); }
}

boot();
