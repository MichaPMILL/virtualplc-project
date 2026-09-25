# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/MichaPMILL/virtualplc-project/security/advisories/new)
rather than opening a public issue. You will get an answer within a few days.

## Security functions

The CPU (`vplc-cpu`) has user accounts with roles, login lockout, TLS with key pinning,
signed programs, a hash-chained and signed audit trail and signed traceability records.
See [docs/security.md](docs/security.md) for the hardening checklist and the mapping to
IEC 62443, ISO/IEC 27001, NIS2 and PCI DSS. A software bill of materials (CycloneDX) is
produced by `node tools/sbom.mjs` and by the CI.

## Supported versions

Security fixes are made on the latest release and on `main`.

## Scope and assumptions

- VirtualPLC is **not** a safety system and must not be used for safety functions.
- The web IDE/API is meant for trusted engineering networks. Always set `VPLC_API_TOKEN`
  and put the IDE behind HTTPS when it is reachable from other machines.
- Modbus TCP and S7 communication have no authentication or encryption. Restrict them
  (`VPLC_MODBUS_BIND`, `--modbus-port 0`, firewall) to the HMI network.
- Microcontroller CPUs (ESP32, Pico) have no accounts and no TLS: isolated networks only.
