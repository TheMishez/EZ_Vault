'use strict';
const crypto = require('crypto');
const WORDS = require('./wordlist.json'); // ~4,000 common English words (SCOWL/hunspell, see WORDLIST-LICENSE.txt)

const SETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.<>/?~'
};
const AMBIGUOUS = /[O0oIl1|`'"]/g;
const SEPARATORS = { '-': '-', '.': '.', '_': '_', ' ': ' ', ',': ',', '': '' };

const clampInt = (n, lo, hi, d) => { n = Math.floor(Number(n)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const clampLength = (n) => clampInt(n, 8, 128, 20);

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Random-character password from the OS CSPRNG; at least one of each selected character type. */
function generatePassword(opts = {}) {
  const length = clampLength(opts.length ?? 20);
  const chosen = ['upper', 'lower', 'digits', 'symbols']
    .filter((k) => opts[k] !== false)
    .map((k) => (opts.avoidAmbiguous ? SETS[k].replace(AMBIGUOUS, '') : SETS[k]))
    .filter((s) => s.length > 0);
  if (chosen.length === 0) chosen.push(SETS.lower);
  const all = chosen.join('');
  const out = chosen.map((set) => set[crypto.randomInt(set.length)]);
  while (out.length < length) out.push(all[crypto.randomInt(all.length)]);
  const value = shuffle(out).join('');
  return { value, bits: Math.round(length * Math.log2(all.length)) };
}

/** Diceware-style passphrase, e.g. "Tundra-Blaster-Ozone-Ripple-Mango-Fable7". */
function generatePassphrase(opts = {}) {
  const count = clampInt(opts.words ?? 6, 3, 12, 6);
  const sep = Object.prototype.hasOwnProperty.call(SEPARATORS, opts.separator) ? opts.separator : '-';
  const words = [];
  for (let i = 0; i < count; i++) words.push(WORDS[crypto.randomInt(WORDS.length)]);
  const parts = words.map((w) => (opts.capitalize !== false ? w[0].toUpperCase() + w.slice(1) : w));
  let bits = count * Math.log2(WORDS.length);
  if (opts.number !== false) {
    const at = crypto.randomInt(count);
    parts[at] += String(crypto.randomInt(10));
    bits += Math.log2(10) + Math.log2(count);
  }
  return { value: parts.join(sep), bits: Math.round(bits) };
}

function generate(opts = {}) {
  return opts.mode === 'passphrase' ? generatePassphrase(opts) : generatePassword(opts);
}

module.exports = { generate, generatePassword, generatePassphrase, clampLength, WORD_COUNT: WORDS.length };
