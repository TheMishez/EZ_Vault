// EZ Vault — password strength estimator.
// Shared between the main process (security audit) and the renderer (live meter).
(function (root) {
  'use strict';

  const COMMON = new Set([
    '123456', '123456789', '12345678', 'password', 'qwerty', '12345', '1234567', '111111',
    '123123', 'abc123', '1234567890', 'password1', '000000', 'iloveyou', '1234', 'qwerty123',
    'dragon', 'monkey', 'letmein', 'football', 'baseball', 'welcome', 'admin', 'login',
    'master', 'sunshine', 'princess', 'shadow', 'superman', 'trustno1', 'passw0rd', 'starwars',
    'qwertyuiop', '654321', '666666', '121212', 'zaq12wsx', 'michael', 'charlie', 'jordan23',
    'hunter2', 'gamer', 'gaming', 'counterstrike', 'csgo', 'cs2', 'valorant', 'fortnite',
    'minecraft', 'steam', 'killer', 'pokemon', 'matrix', 'whatever', 'freedom', 'qazwsx'
  ]);

  const SEQS = ['abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

  function poolSize(pw) {
    let pool = 0;
    if (/[a-z]/.test(pw)) pool += 26;
    if (/[A-Z]/.test(pw)) pool += 26;
    if (/[0-9]/.test(pw)) pool += 10;
    if (/[^A-Za-z0-9]/.test(pw)) {
      // eslint-disable-next-line no-control-regex
      pool += /[^\x00-\x7F]/.test(pw) ? 100 : 33;
    }
    return pool;
  }

  function sequencePenalty(pw) {
    const lower = pw.toLowerCase();
    let hits = 0;
    for (const seq of SEQS) {
      for (let i = 0; i + 3 <= seq.length; i++) {
        const chunk = seq.slice(i, i + 3);
        if (lower.includes(chunk)) hits++;
        const rev = chunk.split('').reverse().join('');
        if (lower.includes(rev)) hits++;
      }
    }
    return Math.min(hits * 4, 30);
  }

  function estimate(pw) {
    if (!pw) return { bits: 0, score: 0, label: 'Empty' };
    const base = pw.toLowerCase().replace(/[^a-z0-9]/g, '');
    const leet = base.replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't');
    if (COMMON.has(pw.toLowerCase()) || COMMON.has(base) || COMMON.has(leet) || COMMON.has(base.replace(/\d+$/, ''))) {
      return { bits: 5, score: 0, label: 'Very weak', common: true };
    }
    const len = [...pw].length;
    const pool = poolSize(pw);
    let bits = len * Math.log2(Math.max(pool, 1));
    const unique = new Set(pw).size;
    const variety = Math.min(1, unique / Math.max(1, len * 0.6));
    bits *= 0.5 + 0.5 * variety;
    bits -= sequencePenalty(pw);
    if (/^(.)\1+$/.test(pw)) bits = Math.min(bits, 4);
    bits = Math.max(0, Math.round(bits));

    let score, label;
    if (bits < 28) { score = 0; label = 'Very weak'; }
    else if (bits < 45) { score = 1; label = 'Weak'; }
    else if (bits < 60) { score = 2; label = 'Fair'; }
    else if (bits < 80) { score = 3; label = 'Strong'; }
    else { score = 4; label = 'Very strong'; }
    return { bits, score, label };
  }

  const api = { estimate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EZStrength = api;
})(typeof self !== 'undefined' ? self : this);
