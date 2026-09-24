# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/MichaPMILL/virtualplc-project/security/advisories/new)
rather than opening a public issue. You will get an answer within a few days.

## Scope and assumptions

- VirtualPLC is **not** a safety system and must not be used for safety functions.
- The web IDE/API is meant for trusted engineering networks. Always set `VPLC_API_TOKEN`
  and put the IDE behind HTTPS when it is reachable from other machines.
- Modbus TCP has no authentication or encryption. Restrict the Modbus server
  (`VPLC_MODBUS_BIND`, firewall) to the HMI network.
