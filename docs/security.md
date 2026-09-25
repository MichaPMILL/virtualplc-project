# Security of VirtualPLC

This page describes the security functions of the VirtualPLC CPU (`vplc-cpu`, Linux /
Raspberry Pi) and of the Studio, how to commission a hardened CPU, and how the functions
map to **IEC 62443**, **ISO/IEC 27001:2022**, **NIS2** and **PCI DSS v4.0**.

> A product is never "compliant" on its own: NIS2, ISO 27001 and PCI DSS apply to an
> organisation and IEC 62443-3-3 to a system (zones and conduits). VirtualPLC provides the
> technical controls that these frameworks require from an automation component. The
> **Gaps** section lists what the plant must bring (network segmentation, MFA on remote
> access, backups, processes).

## Threat model

| Asset | Threats | Controls |
|---|---|---|
| Program of the CPU | unauthorised or tampered download, rogue engineering station | accounts and roles, signed programs, TLS, audit |
| Process values (outputs, set points) | unauthorised writes and forces | roles (operator / engineer), HMI write rights per variable, audit |
| Traceability records | alteration, deletion, forgery | hash chain + Ed25519 signature per record, exactly-once transfer ([traceability.md](traceability.md)) |
| Credentials (users, databases) | disclosure, brute force | PBKDF2, lockout, secrets stored only on the CPU (mode 0600), never sent back |
| Studio ↔ CPU link | eavesdropping, man in the middle, impersonation of the CPU | TLS 1.2+/1.3, CPU key pinned in the project |
| Audit trail | erasure of traces | hash chain + CPU signature, copy to syslog / SIEM |

Out of scope: safety functions (VirtualPLC is not a safety PLC), physical attacks on the
device, the security of the operating system (use a maintained distribution with automatic
security updates).

## Functions

### Accounts and roles (least privilege)

Each CPU keeps its own user accounts (`<data dir>/users`, mode 0600). Every command of the
device protocol requires a role:

| Role | Allowed |
|---|---|
| `viewer` (lecture seule) | state, variables, diagnostics, messages, data logs, audit trail |
| `operator` (opérateur) | + write variables, RUN / STOP |
| `engineer` (ingénieur) | + download, upload, forcing, database credentials, data log tests |
| `admin` (administrateur) | + users, trusted engineering keys |

- First administrator, on the CPU (the password is typed, never on the command line):
  `vplc-cpu --data /var/lib/virtualplc --add-user admin --role admin`.
  Then everything is done in the Studio: *PLC › Sécurité*.
- Passwords: PBKDF2-HMAC-SHA256, 16-byte random salt, iterations calibrated to about 20 ms
  on the device (at least 100 000); constant-time comparison; the same time is spent for
  unknown users (no user enumeration).
- Password policy: 10 characters minimum, 3 kinds out of lower case, upper case, digits,
  symbols. Users change their own password (the current one is asked).
- Lockout: 5 failures in a row block the logins for 30 s (then 30 s after each new failure).
- The last administrator cannot be deleted nor downgraded.
- Without accounts, `--password-file` keeps working (one password, administrator role); a CPU
  with neither is *open* and the Studio warns about it at every connection.

### Encrypted Studio link and CPU identity

- `vplc-cpu` serves TLS (1.2 minimum, 1.3 preferred) and the plain protocol on the same port;
  `--tls-required` refuses plain connections (the serial link stays available locally).
- The certificate is made with the **identity key of the CPU** (`<data dir>/identity.pem`,
  Ed25519), the key that also signs the data logs and the audit trail. Its fingerprint is
  printed at startup (`CPU key fingerprint 3f9a 12c0 …`).
- The Studio shows the fingerprint at the first connection and pins the key in the project
  (*Configuration des appareils › Protection & sécurité*). A device answering at the same
  address with another key is refused (replacement of a CPU: *Oublier*, then check the new
  fingerprint).
- Microcontroller CPUs (ESP32, Pico) have no TLS: use them on an isolated network or through
  their serial link.

### Signed programs

- The Studio signs every download with the Ed25519 key of the engineering workstation
  (`~/.virtualplc/engineering-key.pem`, or `VPLC_ENGINEERING_KEY`).
- With `--signed-programs` the CPU loads only programs signed by a **trusted** key, at the
  download and again at every start (`program.sig` is kept with the program): a program
  changed on the SD card does not start.
- Trusted keys: *Sécurité › Programmes signés › Faire confiance à la clé de ce poste*
  (administrator) or `vplc-cpu --trust-key alice:<hex>`.

### Audit trail

- Recorded: logins, failures, lockouts, denied operations, downloads (with the signer),
  refused programs, RUN/STOP, variable writes, forces, uploads, database credentials, user
  and key management, CPU faults, service start and stop — with user, client address and
  time.
- `<data dir>/audit.log`: one JSON object per line, **hash-chained and signed** by the CPU
  (same scheme as the data logs):
  `chain(n) = sha256(chain(n-1) | seq|ts|user|peer|action|detail)`, `chain(0) = sha256("VirtualPLC audit|<plc>")`.
  A deleted, inserted or changed record is detected (*Vérifier l'intégrité* in the Studio,
  `verifyAudit()` in the SDK). Rotation at 16 MB (`audit.log.1`).
- `--audit-syslog` copies every record to syslog (facility `authpriv`) for a central log
  server / SIEM; the records keep their chain there.
- Time stamps come from the system clock: synchronise it (NTP / PTP).

### Other measures

- Secrets (database passwords) are sent once to the CPU, stored in `<data dir>/secrets`
  (0600) and never returned; the audit trail records the change, not the value.
- Minimal functionality: S7 and OPC UA servers are off unless enabled in the project;
  OPC UA writes and anonymous access are separate options.
- systemd unit ([deploy/vplc-cpu.service](../deploy/vplc-cpu.service)): dedicated user,
  minimal capabilities, read-only system, system call filter, `UMask=0077`.
- Supply chain: SBOM in CycloneDX format (`node tools/sbom.mjs sbom.cdx.json`, built by the
  CI), `npm audit` in the CI, Dependabot updates; native libraries: OpenSSL and SQLite of
  the distribution, open62541 downloaded with a pinned SHA-256.
- No code under GPL; no network access at run time other than the configured services and
  databases.
- Vulnerability handling: [SECURITY.md](../SECURITY.md).

## Commissioning checklist (hardened CPU)

1. Install the CPU with the provided systemd unit (it runs `--tls-required --signed-programs
   --audit-syslog`).
2. Create the administrator on the CPU (`--add-user`), note the key fingerprint printed at
   startup (`journalctl -u vplc-cpu | grep fingerprint`).
3. Studio: *Liaison en ligne* with the administrator; compare the fingerprint; trust it.
4. *Sécurité*: create one account per person (no shared accounts) with the smallest role;
   trust the engineering key of each engineering workstation.
5. HMIs: prefer OPC UA with a user; Modbus TCP and S7 have no authentication — keep them
   off or on the HMI network only (firewall).
6. Put the CPU in a zone of its own (IEC 62443-3-2): only the engineering and HMI conduits
   are open (TCP 20105, and 4840 / 102 / 5020 if used); remote access through a VPN with
   MFA.
7. Forward syslog to the central log server; synchronise the clock.
8. Back up `<data dir>` (program, users, keys, identity, data logs) — the identity key
   proves the origin of the records: keep the backup encrypted.

## Compliance mapping

### IEC 62443-3-3 (system requirements) and IEC 62443-4-2 (component requirements)

| Requirement | VirtualPLC |
|---|---|
| SR/CR 1.1 Human user identification and authentication | per-person accounts on the CPU |
| SR/CR 1.2 Software process and device identification | CPU identity key (Ed25519), pinned by the Studio; engineering keys |
| SR/CR 1.3 Account management | admin role: create, change role, reset, delete; last admin protected |
| SR/CR 1.4 Identifier management | unique names, validated |
| SR/CR 1.5 Authenticator management | PBKDF2 hashes, 0600 files, passwords never on the command line, own password change |
| SR/CR 1.7 Strength of password-based authentication | policy (length, character kinds) enforced by the CPU and the Studio |
| SR/CR 1.8 PKI certificates | self-signed CPU certificate with key pinning (no plant PKI needed) |
| SR/CR 1.9 Strength of public key authentication | Ed25519 keys, signature checked for every program |
| SR/CR 1.11 Unsuccessful login attempts | lockout after 5 failures |
| SR/CR 2.1 Authorization enforcement | role checked for every command; HMI write rights per variable |
| SR/CR 2.8 Auditable events | audit trail (access control, requests, control actions, configuration changes, faults) |
| SR/CR 2.9 Audit storage capacity | rotation at 16 MB + syslog forwarding |
| SR/CR 2.10 Response to audit processing failures | the CPU keeps running (availability of the process first); syslog copy as second channel |
| SR/CR 2.11 Timestamps | UTC time stamps (ms); clock synchronised by the OS |
| SR/CR 2.12 Non-repudiation | records signed by the CPU; programs signed by the engineer's key |
| SR/CR 3.1 Communication integrity | TLS on the Studio link; CRC on the serial link |
| SR/CR 3.4 Software and information integrity | signed programs, checked at every start; signed data logs |
| SR/CR 3.9 Protection of audit information | hash chain + signature, file 0600, viewer role at least |
| SR/CR 4.1 Information confidentiality | TLS; secrets never returned; TLS to the databases |
| SR/CR 5.1 Network segmentation | documented zones and conduits (checklist) |
| SR/CR 7.1 Denial of service protection | limited number of clients, login lockout, outputs to safe state on STOP / fault |
| SR/CR 7.6 Network and security configuration settings | command-line options and project settings, documented |
| SR/CR 7.7 Least functionality | optional servers off by default, hardened systemd unit |

Security level targeted for the CPU: **SL 2** (with the plant measures of the checklist).
SL 3 would additionally need MFA for human users (SR 1.1 RE 2) and hardware-protected keys.

### ISO/IEC 27001:2022, Annex A

| Control | VirtualPLC |
|---|---|
| 5.15 Access control, 5.18 Access rights | roles, least privilege, administrator-only account management |
| 5.16 Identity management, 5.17 Authentication information | personal accounts, PBKDF2, password policy |
| 5.33 Protection of records | traceability and audit trail chained and signed |
| 8.2 Privileged access rights | engineer / admin roles separated from operators |
| 8.5 Secure authentication | lockout, no user enumeration, TLS |
| 8.9 Configuration management | hardening checklist, project under Git in the Studio |
| 8.15 Logging, 8.16 Monitoring activities | audit trail, syslog / SIEM |
| 8.17 Clock synchronization | UTC time stamps, NTP of the OS |
| 8.20 / 8.22 Network security, segregation | zones and conduits, `--tls-required` |
| 8.24 Use of cryptography | TLS 1.2+, Ed25519, SHA-256, PBKDF2 (OpenSSL) |
| 8.8 Technical vulnerabilities, 8.28 Secure coding | SBOM, npm audit, Dependabot, SECURITY.md, tests |
| 8.32 Change management | signed programs, audit of downloads with the signer |

### NIS2 (Directive (EU) 2022/2555), article 21(2)

| Measure | VirtualPLC |
|---|---|
| (a) risk analysis and security policies | threat model above |
| (b) incident handling | audit trail, syslog forwarding, lockout and denial events |
| (c) business continuity, backups | backup of `<data dir>` (checklist), store-and-forward of the data logs |
| (d) supply chain security | SBOM, pinned third-party sources, dependency audit |
| (e) security in acquisition, development and maintenance, vulnerability handling | SECURITY.md, CI, signed programs |
| (g) cyber hygiene | hardened defaults, warnings for open CPUs and plain links |
| (h) cryptography | TLS, signatures, hashes |
| (i) access control, asset management | roles, CPU identity keys (asset inventory by fingerprint) |
| (j) multi-factor authentication | **plant side**: VPN with MFA for remote access (see gaps) |

### PCI DSS v4.0

PLCs are normally kept **out of the cardholder data environment** (segmentation, req. 1).
When a VirtualPLC CPU is in scope (e.g. a vending or payment kiosk):

| Requirement | VirtualPLC |
|---|---|
| 1 network security controls | zones and conduits, only the required ports |
| 2 secure configurations | no default account, hardened systemd unit, optional services off |
| 4 strong cryptography in transit | TLS on the Studio link and to the databases |
| 6.3 vulnerabilities, 6.3.2 inventory | SBOM, npm audit, Dependabot |
| 7 need to know | roles |
| 8.2 unique IDs, 8.3.4 lockout, 8.3.6 password length | personal accounts, lockout, 10 characters minimum¹ |
| 8.4 MFA | **plant side** (VPN / jump host with MFA) |
| 10 audit logs, 10.3 protection, 10.4 review | signed audit trail, syslog to the SIEM |
| 10.6 time synchronization | NTP of the OS |
| 11.5 change detection | signed programs checked at start, chained audit and data logs |

¹ PCI DSS 8.3.6 requires 12 characters (or 8 if the system cannot): set the policy of the plant
accordingly when the CPU is in scope.

## Gaps and plant measures

- **MFA** is not built into the CPU: remote access must go through a VPN or a jump host with
  MFA (NIS2 21(2)(j), PCI DSS 8.4, IEC 62443 SR 1.1 RE 2).
- **Central identities** (LDAP, RADIUS) are not supported: accounts are per CPU.
- **Password expiry** is not enforced (current NIST SP 800-63B guidance: change on
  compromise); the audit trail shows the date of the last change.
- **Modbus TCP and S7** have no security by design: keep them off or on a dedicated HMI
  network.
- **Microcontroller CPUs** (ESP32, Pico) have neither accounts nor TLS: isolated network
  or serial link only.
- The **web IDE** (PHP) is a legacy engineering tool: keep it on localhost or behind HTTPS and
  `VPLC_API_TOKEN`.
