# VirtualPLC device protocol (version 1)

Used by the Studio to talk to a CPU, over **TCP port 20105** (Linux, ESP32) or a
**serial line** at 115200 baud (Arduino). Identifiers are defined in
`protocol` in [`spec/isa.json`](../spec/isa.json).

## Framing

All integers are little-endian.

```
Request:   'V' 'P' · u8 command · u8 sequence · u32 length · payload · u32 crc32
Response:  'V' 'R' · u8 command · u8 sequence · u8 status · u32 length · payload · u32 crc32
```

The CRC-32 covers everything from the command byte to the end of the payload.
One request is answered by exactly one response with the same sequence number.
The maximum payload is 4096 bytes (1024 on small targets, see `INFO`).

## Commands

| Command          | Request payload                                    | Response payload                                  |
|------------------|----------------------------------------------------|---------------------------------------------------|
| `INFO`           | –                                                  | JSON: device, firmware, name, sizes, `maxPayload`, `maxProgram`, `auth` |
| `AUTH`           | password (UTF-8)                                   | –                                                 |
| `STATE`          | –                                                  | JSON: state, programId, scan statistics, fault    |
| `STOP`           | –                                                  | –                                                 |
| `START`          | u8 mode (0 = warm restart, 1 = cold: reset data)   | –                                                 |
| `DOWNLOAD_BEGIN` | u32 size, u32 crc32 of the image                   | – (the CPU stops)                                 |
| `DOWNLOAD_CHUNK` | u32 offset, bytes                                  | –                                                 |
| `DOWNLOAD_END`   | –                                                  | – or error text (image checked, stored, loaded)   |
| `READ`           | n × (u8 area, u32 offset, u16 length)              | the requested bytes, concatenated                 |
| `WRITE`          | n × (u8 area, u32 offset, u8 bit, u16 length, bytes) — bit = 0xFF for a byte write | –         |
| `FORCE`          | n × (u8 area I/Q, u32 byte, u8 bit, u8 value) — value 2 removes the force | –                          |
| `UNFORCE_ALL`    | –                                                  | –                                                 |
| `LOGS`           | u32 first sequence number wanted                   | JSON array of `{seq, t, msg}`                     |
| `UPLOAD`         | u32 offset                                         | u32 total size, then image bytes from offset      |

Areas are `D`, `I`, `Q`, `M` (see `areas`). When the device is protected by a
password, every command except `INFO` and `AUTH` answers `UNAUTHORIZED` until a
successful `AUTH` on the connection.

### `STATE` example

```json
{"state":"RUN","programId":"9f3a12c0","scans":18234,"scanUs":412,"maxScanUs":1830,
 "cycleMs":10,"forces":0,"fault":null,"io":[{"module":0,"ok":true}]}
```

In `FAULT`, `fault` is `{"code":"DIV_ZERO","function":3,"line":27,"pc":1432}`.

## Behaviour

- `DOWNLOAD_BEGIN` stops the CPU. The new image is checked (CRC, structure,
  memory needs) before being stored; if it is rejected the previous program is
  reloaded. After a successful download the CPU is in `STOP`: send `START`.
- In `STOP` and `FAULT` all outputs are switched off.
- At power-on a CPU with a stored program starts it automatically.

## Modbus TCP server (Linux CPU)

For HMIs/SCADA, the Linux CPU also serves Modbus TCP (default port 5020):

| Modbus table             | PLC memory                       |
|--------------------------|----------------------------------|
| Coils (0x)               | `%M` bits (coil n = `%Mn/8.n%8`) |
| Discrete inputs (1x)     | `%I` bits                        |
| Input registers (3x)     | `%IW` (register n = `%IW(2n)`)   |
| Holding registers (4x)   | `%MW` (register n = `%MW(2n)`)   |
