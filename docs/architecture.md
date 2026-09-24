# VirtualPLC architecture

VirtualPLC works like a commercial PLC: an **engineering tool** on the PC and a
**CPU** that runs the compiled program.

```
┌──────────────────────── Engineering PC (macOS / Linux / Windows) ─────────────────────────┐
│ VirtualPLC Studio (Electron)                                                              │
│   Project tree · Device configuration · PLC tags · OB/FC/FB/DB editors · Watch & force    │
│   @virtualplc/sdk (TypeScript): SCL ─► parse ─► analyze ─► bytecode image + symbols │
└──────────────────────────────────────┬────────────────────────────────────────────────────┘
                                       │  VirtualPLC device protocol (TCP 20105 or serial)
                                       │  download · start/stop · read/write · force · state
┌──────────────────────────────────────▼────────────────────────────────────────────────────┐
│ VirtualPLC CPU (C++17, same VM everywhere)                                                │
│   ├─ Linux / Raspberry Pi : TCP server, Modbus TCP remote I/O, Modbus server for HMIs     │
│   ├─ ESP32                : Wi-Fi, GPIO ─► %I/%Q, program stored in flash                 │
│   └─ Arduino (Mega, Due, Opta, Portenta …) : serial protocol, GPIO ─► %I/%Q               │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

## Why a bytecode VM

- **Microcontrollers**: an ESP32 or an Arduino cannot run PHP or JavaScript, but a
  small C++ interpreter of a compact bytecode fits in a few kilobytes of RAM.
- **Fast downloads**: loading a new program is a transfer of a few kilobytes,
  no recompilation or reflashing of the firmware.
- **One semantics**: the same compiler and the same VM on every target, validated
  by the same conformance tests.
- **Static memory**: the compiler lays out every variable at a fixed address;
  the VM performs no dynamic allocation after the program is loaded.

## Components

| Directory    | Content                                                                 |
|--------------|-------------------------------------------------------------------------|
| `spec/`      | `isa.json`: instruction set, memory areas, library blocks, protocol ids |
| `sdk/`       | TypeScript SDK: compiler, device client, project model, CLI `vplc`      |
| `runtime/`   | C++ VM core and platform layers (Linux, ESP32, Arduino)                 |
| `studio/`    | Electron engineering application                                        |
| `src/`, `public/`, `bin/` | Original PHP implementation (reference interpreter, web IDE) |

`spec/isa.json` is the single source of truth: `node tools/gen-isa.mjs` generates
`sdk/src/isa.ts` and `runtime/core/isa.h`.

See [bytecode.md](bytecode.md) for the program image and the VM, and
[protocol.md](protocol.md) for the device protocol.
