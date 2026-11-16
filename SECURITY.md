# Security Policy

EZ Vault protects people's passwords, so we take every report seriously.

## Reporting a vulnerability

**Please report security issues privately. Don't open a public issue, pull request or Discussion.**

1. Go to the **[Security tab of this repository](../../security/advisories/new)** and click **"Report a vulnerability"**. You can also get there in EZ Vault from **Settings → Report a security issue → Report privately**.
2. Describe the issue, how to reproduce it, and what an attacker could do with it.
3. **Never include real passwords, vault files or Emergency Kits.** Use a test vault.

Reports are visible only to the EZ Vault maintainers. We aim to:

- confirm we got your report within **3 days**
- share our assessment and a fix plan within **10 days**
- release a fix and credit you in the advisory, if you want credit, once it's patched

Please give us a reasonable chance to fix the issue before you disclose it publicly.

## Scope

**In scope:**

- the EZ Vault app
- vault encryption and the file format
- the Secret Key and Emergency Kit
- the backup and restore system
- IPC between the app's processes
- the auto-update process
- the Electron hardening

**Out of scope:**

- attacks that need malware already running as your Windows user
- attacks that need physical access to an unlocked PC
- social engineering
- vulnerabilities in Windows or Electron that should be reported upstream

## Supported versions

Only the latest release of EZ Vault gets security fixes. Please update before reporting.

---

*This channel is for EZ Vault security issues only. For EZ Pads and store questions, visit [ezggco.com](https://ezggco.com).*
