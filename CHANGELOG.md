# Changelog

## 1.2.1
- Fixed: the "enter your master password" box never appeared (protected items, Secret Key on a new PC, turning protections down). Error codes were being dropped by Electron's context bridge; they now pass through as plain data.
- Master password screens explain what "bits" means.
- "Forgot your master password? Reset EZ Vault" on the unlock screen. You confirm by typing RESET. An encrypted copy of the old vault is kept by default, or you can tick a box to wipe everything.

## 1.2.0
- **Steam Guard codes:** paste your `shared_secret` or a `.maFile` and get live 5-character Steam codes.
- **Passphrase generator,** for example `Tundra-Blaster-Ozone7-Ripple-Mango-Fable`. You choose the number of words, the separator, capitalization and whether to add a number.
- **Automatic encrypted backups:**
  - Hourly snapshots are kept for 48 hours, then one per day for 30 days.
  - You can add an optional second backup folder, such as a USB stick.
  - Restore takes one click and keeps a safety copy of your current vault.
- **Trash:** deleted items are kept for 30 days, and each delete has an Undo button. You can restore items or delete them forever.

## 1.1.0
- **Secret Key** (160-bit) plus master password, with an Emergency Kit.
- **Stronger key stretching:** scrypt at 256 MB per guess. The data key is wrapped by an HKDF-derived key, and that derived key is never kept in memory.
- **"Require master password" items,** plus a new API key item type.
- **Re-authentication** before exporting, viewing the Emergency Kit or lowering any protection.
- **Brute-force lockout** that survives restarts.
- **Zero network access,** permission lockdown and a full UI reload when the vault locks.
- **Electron fuses** and anti-debugging checks in packaged builds.
- **Clipboard history warning** in the Security check.

## 1.0.0
- First release: an encrypted local vault with logins and notes, a 2FA code generator, a password generator, a Security check, streamer mode, auto-lock and CSV import/export.
