# PROFIBUS DP (master)

The Linux CPU is a **PROFIBUS DP master (class 1, DP-V0)** through an RS-485 adapter: a USB to
RS-485 converter (FTDI and similar, with automatic direction control) or a serial port with an
RS-485 transceiver. The FDL telegrams and the DP services are implemented in-house (no
third-party stack): Slave_Diag, Set_Prm (watchdog, ident number, user parameters), Chk_Cfg,
Data_Exchange with the frame count bit, high-priority answers (new diagnosis) and extended
diagnosis.

| | |
|---|---|
| Speeds | 9.6 kbit/s … 12 Mbit/s, set with termios2 (the adapter must accept the speed: 500 kbit/s and 1.5 Mbit/s are widely supported) |
| Characters | 8 data bits, even parity, 1 stop bit |
| Masters | one master per bus (the CPU); several buses = several adapters |
| Slaves | up to 125 per bus; parameters and modules from the GSD file |
| Loss of a slave | 3 exchanges without answer: inputs to 0, parameterisation again every second |
| Diagnostics | state, station status bytes in clear, extended diagnosis bytes, bus cycle, exchanges and losses |

Not supported: multi-master token passing, DP-V1 acyclic services, DP-V2 (isochronous mode,
slave-to-slave), FMS. Bus termination and cabling follow the PROFIBUS rules (terminators at both
ends, cable type A).

## In the Studio

*Configuration des appareils* › **+** › **Esclave PROFIBUS DP (fichier GSD)…**: choose the GSD
file of the slave, then:

- *Bus*: serial port of the adapter (e.g. `/dev/ttyUSB0`), speed, master address; the slaves of
  the same port form one bus and share its speed;
- *Esclave*: PROFIBUS address set on the slave, ident number (from the GSD), watchdog, user
  parameters;
- *Modules*: modules of a modular slave in their slot order; the configuration identifiers and
  the %I / %Q sizes follow.

Without a GSD file: **Esclave PROFIBUS DP (maître DP)** and the configuration identifiers typed in
hexadecimal. `DEVICE_OK(<module>)` and `DEVICE_DIAG(<module>)` give the state of the slave to the
program.

## Test without hardware

`sdk/test/profibus.test.ts` drives a simulated slave through a pseudo-terminal pair (socat):
parameters, configuration, data exchange, extended diagnosis, loss and return of the slave,
configuration fault.
