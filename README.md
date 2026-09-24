# VirtualPLC

**A soft-PLC written in PHP: Structured Text (SCL / IEC 61131-3) runtime, Modbus TCP I/O, and a web IDE.**

[![CI](https://github.com/MichaPMILL/virtualplc-project/actions/workflows/ci.yml/badge.svg)](https://github.com/MichaPMILL/virtualplc-project/actions/workflows/ci.yml)

VirtualPLC runs SCL programs cyclically like a real PLC, reads and writes remote
Modbus TCP I/O modules (e.g. Waveshare relay boards), and exposes every program
variable to HMIs/SCADA through its own Modbus TCP server.

> [!WARNING]
> VirtualPLC is **not a safety PLC**. It runs on a general-purpose OS, has no
> certified timing guarantees and must **never** be used for safety functions
> (emergency stops, personnel protection, ...). Use certified safety hardware
> for those, and treat VirtualPLC as supervisory/automation logic only.

## VirtualPLC Studio + portable CPU (new architecture)

Next to the PHP soft-PLC, the repository now contains a complete engineering
workflow that targets small hardware:

```
 VirtualPLC Studio (Electron, Windows/macOS/Linux)
   project tree · device view · tag tables · OB/FB/FC/DB editors (SCL, CONT) · watch tables
        │ compiles SCL → bytecode (sdk/)
        ▼ TCP 20105 (download, RUN/STOP, monitoring, forcing, diagnostic buffer)
 vplc-cpu (portable C++ VM, runtime/)  →  Linux PC, Raspberry Pi (GPIO), Modbus TCP remote I/O
                                          (ESP32 / Arduino firmware: planned)
```

| Path       | Content                                                                   |
|------------|---------------------------------------------------------------------------|
| `spec/`    | Instruction set (single source of truth, generates `sdk/src/isa.ts` and `runtime/core/isa.h`) |
| `sdk/`     | TypeScript SCL compiler, project model (`.vplcproj`), device client, `vplc` CLI |
| `runtime/` | C++ VM and CPU (`vplc-cpu`, `vplc-sim`), CMake                            |
| `studio/`  | The engineering application                                               |
| `docs/`    | `architecture.md`, `bytecode.md`, `protocol.md`                           |

Studio uses the usual automation vocabulary and layout (portal view / project view, *Appareils &
réseaux*, *Blocs de programme*, *Variables API*, *Tables de visualisation*, inspector
window, task cards, online mode in orange, *Charger dans l'appareil*, *Visualisation
on/off*, *Forcer*), so an automation engineer finds everything where they expect it.

```bash
# CPU on a Linux box / Raspberry Pi
cmake -S runtime -B runtime/build -DCMAKE_BUILD_TYPE=Release && cmake --build runtime/build -j
runtime/build/vplc-cpu --data /var/lib/virtualplc     # see deploy/vplc-cpu.service

# Studio (desktop)
cd sdk && npm ci && cd ../studio && npm ci
npm start            # Electron app
npm run web          # same UI in a browser on http://127.0.0.1:8123 (development)
npm run dist         # installers: .dmg / NSIS .exe / AppImage + .deb (in studio/release)
```

### Team work and archiving (Git)

Projects are saved as a **folder with one file per object** (`<Project>.vplcproj` manifest,
`devices/<PLC>/blocks/<Block>.json` + `.scl` code — CONT networks stay in the `.json` —, `tags/`, `watch/`), so Git can compare
and merge the work of several engineers. The Studio drives the `git` tool installed on the
workstation (menu *Projet*, toolbar, task card *Versions*):

- **Activer la gestion de versions**: creates the repository and archives a first version.
- **Archiver une version**: saves the project and records it with a comment (author, date).
- **Synchroniser avec l'équipe**: receives the others' versions, merges them, sends yours.
  Objects changed on both sides are listed; pick *Ma version* or *Version de l'équipe* for each.
- **Historique des versions**: compare with the current project or the previous version,
  restore a version, set a mark (e.g. `V1.0` for a commissioning), export a version as `.zip`.
- **Récupérer depuis un dépôt d'équipe**: first copy of a shared project (GitLab, Gitea,
  GitHub, Azure DevOps, or a bare repository on a network share).
- **Dépôts distants**: add, rename, change or remove remotes (e.g. office server + site copy),
  or create a shared repository in a network folder in one click. *Synchroniser* uses the
  remote followed by the current branch (otherwise `origin`, otherwise it asks).
- **Branches**: one branch per engineer or per topic (*Nouvelle branche de travail* proposes
  `firstname-lastname/…`), switch (the project is reloaded), merge another branch into the
  current one, *intégrer* the current branch into `main`, compare, publish, delete (locally
  and on the server). The history can show every branch.

Authentication uses the workstation's Git credentials (Git Credential Manager, SSH keys).

### PROFINET

In-house PROFINET IO stack (RT_CLASS_1, no third-party code) in `vplc-cpu` for Linux / Raspberry Pi
(`runtime/platform/linux/profinet`: DCP, DCE/RPC connection establishment, cyclic data, watchdog):

- **The CPU as IO-Device** of another controller: in *Configuration des appareils*, add
  *IO-Device PROFINET*, choose the network interface, the name of station and the exchanged
  areas (controller outputs → `%I`, controller inputs ← `%Q`), then *Exporter le fichier GSDML*
  and import it into the controller's engineering tool (modules IN / OUT / IN-OUT of 1 to
  128 bytes, mapped in slot order). The controller can set the name and the IP address (DCP);
  they are kept by the CPU.
- **The CPU as IO-Controller**: *+ > Appareil PROFINET (fichier GSDML)...* reads the device's
  GSDML; choose the module of each slot, the name of station, the IP address and the update
  time; addresses are assigned and *Créer les variables API* creates the tags. At start-up the
  CPU finds the device by its name, gives it its IP address, writes the default parameter
  records of the GSDML, and exchanges data every cycle (`DEVICE_OK(PN_1)` in the program).

Requirements: raw Ethernet access (`CAP_NET_RAW`, and `CAP_NET_ADMIN` for the IP set by DCP —
see `deploy/vplc-cpu.service`). Not yet supported: IRT / RT_CLASS_3, alarms and diagnosis from
the devices, shared devices, both roles on the same interface. Use a vendor ID assigned by PI
for devices you distribute (0x0000 is for trials).

### Ladder (CONT)

OB, FB and FC can be programmed in **CONT** (ladder diagram) instead of SCL — choose the
language in *Ajouter nouveau bloc*. The editor draws networks between the power rails:
normally open / closed contacts, rising / falling edge contacts (with their edge memory bit),
`NOT`, assignment / negated / set / reset coils, parallel branches (*Branche*), and boxes:
`TON`, `TOF`, `TP`, `CTU`, `CTD`, `CTUD`, `R_TRIG`, `F_TRIG`, `SR`, `RS`, `MOVE`, `ADD`,
`SUB`, `MUL`, `DIV`, `MOD`, comparisons (`CMP ==`, `<>`, `>`, `>=`, `<`, `<=`), `IN_RANGE`,
`OUT_RANGE` and block calls. Instructions of the task card can be double-clicked (timers and
counters ask for a single or multi-instance, as in SCL). Operands complete from the tags
and the block interface; errors point to the network and the element. With *Visualisation*
on, the power flow is drawn in green and box parameters show their values. Networks are
translated to SCL by the compiler (`sdk/src/ladder.ts`); *CONT→SCL* converts a block for good.

### Data types

Elementary types of the usual engineering tools: `Bool`, `Byte`, `Word`, `DWord`, `LWord`,
`SInt`, `Int`, `DInt`, `LInt`, `USInt`, `UInt`, `UDInt`, `ULInt`, `Real`, `LReal`, `Time`,
`LTime`, `Date`, `Time_Of_Day`, `LTime_Of_Day`, `Date_And_Time`, `LDT`, `DTL`, `Char`,
`WChar`, `String`, `WString`; arrays, structures and PLC data types (UDT). Typed literals
(`D#2024-01-15`, `TOD#12:30:00`, `LT#1D_2H`, `DT#…`, `LDT#…`, `DTL#…`, `CHAR#'A'`,
`LWORD#16#…`), explicit conversions (`DINT_TO_DATE`, `LDT_TO_DTL`, `DT_TO_TOD`,
`TIME_TO_LTIME`, `CHAR_TO_STRING`…), time arithmetic (`TOD + TIME`, `LDT - LDT`…) and the
CPU clock (`RD_SYS_T`, `RD_LOC_T` into a `DTL`, `LDT` or `DT`). `WString` is stored as UTF-8
(254 bytes max); `ULInt` / `LWord` arithmetic above 2^63 behaves as signed.

### HMI / SCADA access

| Protocol | Configured in | Access |
|----------|---------------|--------|
| **OPC UA** (open62541) | CPU properties › *Serveur OPC UA* (port 4840) | variables marked *Accès IHM* (tag tables, DBs, structures as folders), read/write per *Écriture IHM*, subscriptions; anonymous or user/password (`--hmi-user`, `--hmi-password-file`); security policy None |
| **S7 communication** (ISO-on-TCP, PUT/GET) | CPU properties › *Communication S7* (port 102) | absolute `%I`, `%Q`, `%M`, `DBn.DBX/DBB/DBW/DBD` (offsets shown in the DB editor, column *Décalage*); for panels configured with an S7-300/400 connection, rack 0 / slot 2 |
| **Modbus TCP** | `--modbus-port` (5020) | coils = `%M` bits, discrete inputs = `%I`, input registers = `%IW`, holding registers = `%MW` |

Ports below 1024 need `CAP_NET_BIND_SERVICE` (see `deploy/vplc-cpu.service`). OPC UA is
built with open62541 (MPL-2.0), downloaded and checked at CMake time
(`-DVPLC_OPEN62541_DIR=` for offline builds, `-DVPLC_OPCUA=OFF` to leave it out).

### IO-Link

An *IO-Link master (Modbus TCP)* module maps the process data of each port to `%I` / `%Q`
(register and length per port, from the master's Modbus documentation). Importing the
sensor's **IODD** on a port sets the lengths and creates the PLC tags at the right
addresses.

### Importing from other engineering tools

*Projet > Importer des fichiers* (or drag and drop on the window) reads the files that
engineering tools export from their own projects:

| File                     | Content                                                                 |
|--------------------------|-------------------------------------------------------------------------|
| `.scl`                   | SCL external sources: OB, FB, FC, DATA_BLOCK, TYPE, VAR_GLOBAL           |
| `.db`                    | Data block sources (global and instance DBs)                            |
| `.udt`                   | PLC data types (`TYPE "Name" STRUCT … END_STRUCT END_TYPE`, nested structs) |
| `.xlsx`                  | PLC tag table exports (columns Name, Path, Data Type, Logical Address, Comment — English or French headers), one table per *Path* |
| `.xml`                   | SimaticML exports (Openness XML): OB / FB / FC in **LAD** (become CONT blocks with their networks) or **SCL**, global and instance DBs, PLC data types, tag tables and user constants. Titles, comments, start values and HMI access flags are kept; networks that cannot be translated are reported and left empty |

**Whole projects (`.ap17`, `.zap17`, … `.ap19`, `.zap19`)**: the binary project files and
archives are deliberately **not** read — their formats are undocumented and reading them
would require reverse engineering. [`tools/openness-export`](tools/openness-export) is a small
command-line tool to run on the engineering PC: it opens the project (or retrieves the
archive) through the vendor's public Openness API and exports every PLC's blocks, data types
and tag tables as XML, ready for *Importer des fichiers* (select all the files of the folder).

## Features

- **SCL language**: `IF/ELSIF/ELSE`, `CASE`, `FOR ... BY`, `WHILE`, `REPEAT`, `EXIT`, `RETURN`,
  `AND/OR/XOR/NOT`, `MOD`, comparisons `= <> < <= > >=`, `BOOL` and `INT` (16-bit, wrap-around),
  hex/binary literals (`16#FF`, `2#1010`), `//`, `(* *)` and `/* */` comments, reusable `BLOCK`s.
- **Static checks before running**: undeclared variables, unknown functions, writes to inputs,
  unknown devices... reported with the line number *in the block you edited*.
- **Real PLC scan semantics**: inputs read once per scan, outputs written once at the end of the
  scan and only when they change (no relay chatter), watchdog, cyclic FC (like OB1).
- **Robust I/O**: timeouts, automatic reconnection with backoff, outputs re-sent after a
  reconnection, `DEVICE_OK()` to react to a lost module.
- **Modbus TCP server for HMIs**: FC 1/2/3/4/5/6/15/16, exception responses, several clients,
  tag name discovery.
- **Hot reload**: deploying from the IDE reloads the program without restarting the service;
  a broken program puts the runtime in `FAULT` (automatic restart) instead of crashing it.
- **Web IDE**: tag table, hardware configuration, block editor with completion, build errors,
  live monitoring and online value changes, runtime status (RUN/FAULT, scan time, I/O state).
  Works offline (no CDN), optional API token.
- **Operations**: systemd unit, Docker image, structured logs on stderr, status file,
  automatic backups of the last 20 deployed programs.

## Architecture

```
 Browser (IDE) ──HTTP/JSON──> public/api.php ──writes──> var/project.scl ─┐
                                   │   ▲                                   │ hot reload
                        commands   │   │ status.json                       ▼
                                   └──►var/◄───────────────── bin/virtualplc run (runtime)
                                                                │        │
                                         Modbus TCP client  ◄───┘        └──► Modbus TCP server
                                         (remote I/O modules)                 (HMI / SCADA, :5020)
```

| Path                   | Content                                                     |
|------------------------|-------------------------------------------------------------|
| `src/Scl`              | Lexer, parser, analyzer and interpreter                     |
| `src/Modbus`           | Modbus TCP client and server                                |
| `src/Runtime`          | Scan loop, I/O process image, device reconnection           |
| `src/Project`          | Web IDE project (JSON) → SCL compiler and validation        |
| `src/Http`             | JSON API                                                    |
| `public/`              | **Web root** (IDE + API). Nothing else must be exposed.     |
| `bin/virtualplc`       | CLI: `run`, `check`, `compile`                              |
| `var/`                 | Runtime data (project, program, status, backups) - not versioned |
| `examples/`            | Example project (server room supervision)                   |

## Quick start

Requirements: PHP ≥ 8.1 with `ctype` and `json` (`pcntl` recommended), Composer.

```bash
git clone https://github.com/MichaPMILL/virtualplc-project
cd virtualplc-project
composer install --no-dev

# 1. Start the runtime (foreground)
bin/virtualplc run

# 2. In another terminal, serve the IDE (development only)
php -S 127.0.0.1:8000 -t public
```

Open http://127.0.0.1:8000, then **Import** `examples/project.json`, adapt the IP of the I/O
module and click **Deploy**.

### Docker

```bash
echo "VPLC_API_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d
```

IDE on http://localhost:8080 (the token is asked on first access), Modbus HMI server on port 5020.

### Production install (systemd + Apache)

```bash
sudo git clone https://github.com/MichaPMILL/virtualplc-project /opt/virtualplc
cd /opt/virtualplc && sudo composer install --no-dev --classmap-authoritative
sudo chown -R www-data:www-data var
sudo cp deploy/virtualplc.service /etc/systemd/system/ && sudo systemctl enable --now virtualplc
sudo cp deploy/apache-vhost.conf /etc/apache2/sites-available/virtualplc.conf   # edit the token!
journalctl -u virtualplc -f
```

The web server and the runtime must share the `var/` directory (same user, or same group
with write access).

## Configuration

Everything is configured through environment variables:

| Variable                | Default   | Description                                                        |
|-------------------------|-----------|--------------------------------------------------------------------|
| `VPLC_DATA_DIR`         | `./var`   | Project, program, status, command and backup files                 |
| `VPLC_API_TOKEN`        | *(empty)* | Token required by the API (`Authorization: Bearer ...`). **Set it in production.** |
| `VPLC_MODBUS_ENABLED`   | `1`       | Start the Modbus TCP server for HMIs                               |
| `VPLC_MODBUS_BIND`      | `0.0.0.0` | Bind address of the Modbus server (`127.0.0.1` to restrict)        |
| `VPLC_MODBUS_PORT`      | `5020`    | Port of the Modbus server                                          |
| `VPLC_CYCLE_MS`         | `100`     | Scan cycle time when the FC returns                                |
| `VPLC_WATCHDOG_MS`      | `5000`    | Max time without yielding (loop without `WAIT`) before a fault; `0` disables |
| `VPLC_IO_TIMEOUT_MS`    | `1000`    | Connect/read timeout for I/O modules                               |
| `VPLC_RESTART_DELAY_MS` | `5000`    | Delay before restarting after a runtime fault                      |
| `VPLC_FAULT_OUTPUTS`    | `hold`    | Outputs on fault/stop: `hold` (keep) or `off` (drive to FALSE)     |
| `VPLC_LOG_LEVEL`        | `info`    | `debug`, `info`, `warning`, `error`                                |

## Language reference

A program has up to five kinds of sections, generated by the IDE from the project:

```iecst
HARDWARE
    Io := CONNECT('192.168.1.50', 502, 1);   // host, port, Modbus unit id
END_HARDWARE

VAR
    Enable  : BOOL;
    Speed   : INT := 10;          // optional initial value
    Button  : Io.INPUT.0;         // discrete input 0 of the module
    Lamp    : Io.OUTPUT.3;        // coil 3 of the module
END_VAR

DB                                // runs once, at start-up
    Enable := TRUE;
END_DB

BLOCK Lighting                    // reusable block, called as Lighting();
    IF NOT DEVICE_OK(Io) THEN
        LOG('I/O module offline');
        RETURN;
    END_IF;
    Lamp := Enable AND Button;
END_BLOCK

FC                                // main program, executed every scan
    Lighting();
END_FC
```

### Scan cycle

The FC runs cyclically, every `VPLC_CYCLE_MS`. Programs written as an explicit loop remain
supported: each `WAIT(ms)` ends the current scan (outputs flushed, HMI served) and waits.

```iecst
WHILE SystemOn DO
    Lighting();
    WAIT(100);
END_WHILE;
```

A loop that never calls `WAIT` is stopped by the watchdog (`FAULT`).

### Statements

```iecst
IF a > 10 THEN ... ELSIF a > 5 THEN ... ELSE ... END_IF;
// "ELSE IF" on a single line is accepted as an alias of ELSIF (one END_IF).
CASE Mode OF
    0:       Motor := FALSE;
    1, 2:    Motor := TRUE;
    10..20:  Alarm := TRUE;
ELSE
    Alarm := FALSE;
END_CASE;
FOR i := 10 TO 0 BY -2 DO ... END_FOR;     // FOR counters are implicitly INT
WHILE cond DO ... END_WHILE;
REPEAT ... UNTIL cond END_REPEAT;
EXIT;     // leave the innermost loop
RETURN;   // leave the current block
```

Identifiers are case-insensitive. `INT` is 16-bit signed (wraps like a real PLC) and `/`
is an integer division. `AND`/`OR`/`XOR`/`NOT` are logical on `BOOL` and bitwise on `INT`.

### Built-in functions

| Function                     | Description                                             |
|------------------------------|---------------------------------------------------------|
| `CONNECT(host, port, unit)`  | Declares a Modbus TCP I/O module (HARDWARE section)     |
| `DEVICE_OK(device)`          | `TRUE` when the module answered during the current scan |
| `DISCONNECT_ALL()`           | Flushes outputs and closes the I/O connections          |
| `WAIT(ms)`                   | Ends the current scan and waits                         |
| `LOG(text, ...)`             | Writes to the runtime log                               |
| `ABS(x)`, `MIN(a, b, ...)`, `MAX(a, b, ...)`, `LIMIT(min, x, max)` | Math                |

### I/O behaviour

- Inputs of a module are read at most once per scan. If a module is offline, its inputs keep
  their last value: test `DEVICE_OK()` when that matters.
- Outputs are written at the end of the scan, only when they changed, and re-sent after a
  reconnection.

## Modbus server (HMI / SCADA)

Every variable is exposed at the address equal to its position in the tag table
(the **REG** number in the IDE):

| Variable                       | Modbus table                          |
|--------------------------------|---------------------------------------|
| `BOOL` bound to an input       | Discrete input (1x), read-only        |
| other `BOOL`                   | Coil (0x), read/write                 |
| `INT`                          | Holding register (4x), read/write, and input register (3x) |

Tag names can be read from input registers `1000 + n × 10` (10 registers, 2 ASCII chars each).

Modbus TCP has no authentication: bind the server to a trusted interface
(`VPLC_MODBUS_BIND`) or firewall port 5020.

## CLI

```bash
bin/virtualplc run                        # start the runtime
bin/virtualplc check examples/project.scl # syntax + semantic check (CI friendly)
bin/virtualplc compile examples/project.json > program.scl
```

## HTTP API

All endpoints are `api.php?action=...`, JSON in and out. `POST` requires
`Content-Type: application/json`. When `VPLC_API_TOKEN` is set, send
`Authorization: Bearer <token>` (except for `health`).

| Action     | Method | Description                                              |
|------------|--------|----------------------------------------------------------|
| `health`   | GET    | Liveness probe                                           |
| `load`     | GET    | Current project                                          |
| `save`     | POST   | Save the project (drafts allowed, not deployed)          |
| `validate` | POST   | Compile without deploying (`422` + `errors` on failure)  |
| `deploy`   | POST   | Validate, save and deploy (`422` + `errors` on failure)  |
| `status`   | GET    | Runtime state, variables, scan time, devices, last error |
| `write`    | POST   | `{"tag": "Name", "value": true}` - applied at next scan  |

## Development

```bash
composer install
composer test            # unit + integration tests (spawns a simulated I/O module)
composer lint
```

## Security checklist

- Set `VPLC_API_TOKEN` and serve the IDE over HTTPS (reverse proxy) if it leaves localhost.
- Expose only `public/` through the web server.
- Restrict the Modbus server with `VPLC_MODBUS_BIND` / a firewall.
- Run the runtime as an unprivileged user (the provided systemd unit does).

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

BSD 3-Clause, see [LICENSE](LICENSE). The bundled Ace editor (`public/assets/ace`) is
BSD-licensed by Ajax.org B.V.
