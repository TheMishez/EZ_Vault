# EZ Vault

A free, offline, open-source password manager for Windows, made by **EZGGco**.

Your vault is one encrypted file on your PC. There's no account, no cloud and no telemetry.

## Features

- **Two-secret encryption.** The vault opens only with your master password **plus** a 160-bit Secret Key (shown once on your Emergency Kit). A stolen vault file can't be cracked even if your master password is guessable.
- **Logins, API keys and secure notes,** with folders, favorites and instant search.
- **"Require master password" items.** Turn it on for API keys, bank logins or recovery codes. These items stay sealed even while the vault is unlocked. API keys get it by default.
- **Built-in 2FA codes** (TOTP) from a setup key or `otpauth://` link.
- **Steam Guard codes.** Paste the `shared_secret` (or a whole Steam Desktop Authenticator `.maFile`) to get the same 5-character codes as the Steam mobile app.
- **Password and passphrase generator** using the OS CSPRNG. Passwords can be 8 to 128 characters. Passphrases are built from a ~4,000-word list (about 12 bits per word, so the default 6 words give 72+ bits), for example `Tundra-Blaster-Ozone7-Ripple-Mango-Fable`.
- **Automatic encrypted backups** after every change:
  - Hourly snapshots are kept for 48 hours, then one per day for 30 days (adjustable).
  - You can mirror them to a second folder, such as a USB stick or another drive.
  - Restoring takes one click from Settings, and your current vault is always saved first so a restore can be undone.
- **Trash.** Deleted items can be restored for 30 days, and every delete has an Undo button.
- **Security check.** Finds weak, reused and old passwords, logins without 2FA, and API keys without the master-password lock. It also warns if Windows clipboard history or cloud clipboard sync is on.
- **Streamer mode** (on by default). The window is blank in OBS, Discord and screenshots.
- **Auto-lock:** after 5 minutes idle, when Windows locks or sleeps, and optionally on minimize.
- **Clipboard auto-clear** after 15 seconds.
- **Import** CSV from Chrome, Edge, Brave, Firefox and Bitwarden. **Export** an encrypted backup, or a plain CSV (master password required).

## Run it

```bash
npm install
npm start
```

## Build the Windows installer

```bash
npm run dist
```

This puts an NSIS installer and a portable `.exe` in `dist/`.

## Tests

```bash
npm test
```

The tests cover encryption round-trips, wrong-password and tamper rejection, master password changes, RFC 6238 TOTP vectors, CSV import/export, the generator and the strength checks.

## Where's my data?

- `%APPDATA%\EZ Vault\vault.ezv` is your encrypted vault, with the previous version kept next to it as `vault.ezv.bak`.
- `%APPDATA%\EZ Vault\secret-keys.json` holds your Secret Key, encrypted with Windows DPAPI so only your Windows account on this PC can read it.

On a new PC, or after reinstalling Windows, you need your **master password and the Secret Key from your Emergency Kit**.

> **If you lose both your master password and your Emergency Kit, your vault cannot be recovered.** This is by design. Nobody else can get in, including EZGGco.

## Security design

**Encryption**

| Layer | What it does |
|---|---|
| scrypt (N=2¹⁸, r=8, p=1) | Every password guess costs about 256 MB of RAM and about 1 second, which cripples GPU/ASIC cracking. Older vaults are upgraded automatically on unlock. |
| Secret Key (160-bit) | Mixed into the key with HKDF. The vault file alone is useless, because it would take 2¹⁶⁰ guesses even if the master password were known. |
| Vault key (DEK) | A random 256-bit key encrypts the data. It's wrapped by the key derived from password + Secret Key, and that derived key is wiped from memory immediately after use. |
| AES-256-GCM | Authenticated encryption with a fresh IV on every save. The header is bound as AAD, so tampering or downgrade attempts are rejected. |
| Atomic, fsynced writes | Saves can't half-write and corrupt the vault. |

**App hardening**

- **Secrets stay out of the UI.** Decryption happens only in Electron's main process. The UI never gets the key, the list never contains passwords, and a password or API key is sent only when you reveal, copy or edit it. Revealed passwords auto-hide after 30 seconds.
- **Lock wipes everything.** Locking zeroes the keys in memory, reloads the UI to throw away any decrypted text, and forces garbage collection.
- **Sensitive actions re-check your master password.** This covers protected items, viewing the Emergency Kit, exporting CSV, and turning protections down (streamer mode, auto-lock, clipboard clear, lock on minimize).
- **Brute-force lockout survives restarts.** After 5 wrong attempts there's an escalating wait, up to 15 minutes.
- **Zero network access.** All web requests are blocked at the session level, permissions are denied, and navigation, pop-ups and webviews are blocked. The UI runs sandboxed with context isolation and a strict CSP.
- **Electron fuses** are flipped in the built .exe (`build/afterPack.js`): no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no `--inspect` debugger, and app code only loads from the packaged archive. Packaged builds also refuse to start with debugging flags and have DevTools disabled.

**What no password manager can stop**

If your PC already has malware running as you (a keylogger or remote-access trojan), it can capture your master password when you type it. To stay safe:

- Keep Windows updated, don't run cracked software or cheats, and use Windows Defender.
- Turn on BitLocker device encryption.
- Turn off clipboard history (Settings → System → Clipboard). The Security check warns you if it's on.
- Code-sign your release builds so nobody can swap in a fake EZ Vault.exe.

## Credits

The passphrase word list is derived from the SCOWL / hunspell en_US dictionary, © Kevin Atkinson and others, under a permissive license. See `src/WORDLIST-LICENSE.txt`.

## License

MIT © 2026 EZGGco
