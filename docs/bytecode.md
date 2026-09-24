# VirtualPLC bytecode and program image (format 1)

Numeric identifiers (opcodes, types, areas, library blocks, …) are defined in
[`spec/isa.json`](../spec/isa.json).

## Memory model

| Area | Name              | Content                                                               |
|------|-------------------|-----------------------------------------------------------------------|
| `D`  | Data memory       | Global tags, data blocks, FB instances, static frames of FCs/FBs/OBs  |
| `N`  | Instance-relative | Offset from the *instance base* of the running FB (resolved to `D`)   |
| `I`  | Inputs            | Process image of inputs `%I`                                          |
| `Q`  | Outputs           | Process image of outputs `%Q`                                         |
| `M`  | Bit memory        | Markers `%M`                                                          |
| `C`  | Constants         | Read-only constant pool (string literals)                             |

- All multi-byte **values in memory are big-endian** (as on most PLCs), so that
  `%MW10` / `%MD20` accesses behave as on a real PLC.
- `BOOL` variables occupy one byte (0/1) in `D`; `BOOL`s of the process image are bits.
- The compiler assigns every variable a fixed address. There is **no recursion**
  (the compiler rejects call cycles), so every FC, FB type and OB has one static
  frame for its temporaries. FB instances are contiguous blocks in `D`
  (inputs, outputs, in-outs as pointers, statics, nested instances).
- Temporaries are reset at each call (the VM zeroes the frame, then the function's
  prologue stores declared start values).

### Layouts

| Type                        | Size | Encoding                                        |
|-----------------------------|------|-------------------------------------------------|
| BOOL                        | 1    | 0 / 1                                           |
| BYTE, USINT / SINT          | 1    | unsigned / two's complement                     |
| WORD, UINT / INT            | 2    |                                                 |
| DWORD, UDINT / DINT, TIME   | 4    | TIME = signed milliseconds                      |
| LINT / ULINT, LWORD         | 8    | (VM types `I64` / `U64`)                        |
| CHAR / WCHAR                | 1 / 2| character code                                  |
| DATE                        | 2    | days since 1990-01-01                           |
| TIME_OF_DAY (TOD)           | 4    | milliseconds since midnight                     |
| LTIME / LTIME_OF_DAY        | 8    | nanoseconds (duration / since midnight)         |
| LDT                         | 8    | nanoseconds since 1970-01-01                    |
| DATE_AND_TIME (DT)          | 8    | BCD: yy mm dd hh mi ss, ms (3 digits), weekday  |
| DTL                         | 12   | YEAR (UInt), MONTH, DAY, WEEKDAY, HOUR, MINUTE, SECOND (USInt), NANOSECOND (UDInt) |
| REAL / LREAL                | 4 / 8| IEEE-754                                        |
| STRING[n] (default n = 32)  | n+2  | max length, current length, characters (WSTRING: same layout, UTF-8, default 254) |
| ARRAY[a..b] OF T            | (b-a+1) × size(T), contiguous                     |
| Pointer (IN_OUT parameter)  | 8    | `area << 32 \| offset`                          |
| Library FB (TON, CTU, …)    | see `libraryBlocks` in `isa.json`                 |

## Execution model

The VM is a stack machine. A **cell** is 64 bits and holds either an integer
(`int64`), a float (`double`) or a pointer (`area << 32 | offset`). The compiler
knows the static type of every expression and emits typed instructions
(`ADD` vs `FADD`, `LOAD I16` …); the VM never checks types at run time.

A scan:

1. read inputs into `%I` (platform), apply forced inputs;
2. run the cyclic OB (entry `main`) until `HALT`, or until `SYS WAIT` suspends it;
3. apply forced outputs, write `%Q` to the outputs (platform);
4. serve the device protocol and wait for the next cycle.

`SYS WAIT(ms)` (historical programs looping forever) suspends the VM: the stack
and the call stack are kept and execution resumes after `WAIT` at the next scan
once the delay has elapsed. Backward jumps check the watchdog.

Runtime errors (`TRAP`, division by zero, array bounds, watchdog …) put the CPU
in `FAULT`; the device reports the trap code and, via the `LINES` section, the
block and source line.

## Program image

All integers of the image container and of instruction operands are
**little-endian**.

```
"VPLC"            4 bytes magic
u16 format        = 1
u16 sectionCount
sections…         u8 type · u32 length · payload
u32 crc32         CRC-32 (IEEE) of every preceding byte
```

| Section   | Payload                                                                                   |
|-----------|-------------------------------------------------------------------------------------------|
| `META`    | u8+bytes program name, u8+bytes compiler version, u32 build time (Unix seconds)           |
| `LIMITS`  | u32 data size, u16 %I size, u16 %Q size, u16 %M size, u16 stack cells, u16 call depth, u16 cycle time (ms) |
| `CODE`    | instructions                                                                              |
| `CONST`   | constant pool (area `C`)                                                                  |
| `INIT`    | initial content of `D` (start values); the rest of `D` is zero                            |
| `FUNCS`   | u16 count, then per function: u32 code offset, u32 frame offset, u32 frame size (in `D`)  |
| `ENTRIES` | u16 startup function (0xFFFF = none), u16 main function                                   |
| `LINES`   | u32 count, then (u32 pc, u16 function, u16 line) sorted by pc — for error reporting       |
| `IOCONF`  | u16 count, then I/O modules (see below)                                                   |
| `SYMS`    | u32 count, then variables visible to HMIs: u8 area, u32 offset, u8 bit (0xFF = none), u8 type (VM type, 0x20 STRING, 0x21 TIME), u16 size, u8 flags (bit0 writable), u8 segment count, segments (u8+bytes) — optional |
| `DBS`     | u16 count, then numbered data blocks: u16 number, u32 offset in `D`, u32 size, u8+bytes name — optional |
| `DATALOGS`| u16 count, then per data log: u8+bytes name, u8 trigger (0 program, 1 edge: u8 area, u32 offset, u8 bit; 2 period: u32 ms), u16 retention days, u8 column count, columns (u8+bytes name, u8 area, u32 offset, u8 bit (0xFF = none), u8 type (as `SYMS`), u16 size), u8 database (0 none, 1 PostgreSQL, 2 MySQL), then u8+bytes host, u16 port, u8+bytes database, u8+bytes table, u8+bytes user, u8 TLS (0 disable, 1 require, 2 verify) — optional, see [traceability.md](traceability.md) |
| `SERVICES`| u16 OPC UA port, u8 flags (bit0 enabled, bit1 write, bit2 anonymous), u16 S7 port, u8 flags (bit0 enabled, bit1 write) — optional |

The **program id** is the CRC-32 of the image; the device reports it so that the
Studio can tell whether the program in the CPU matches the project.

### I/O modules (`IOCONF`)

Each module starts with `u8 kind`:

| Kind         | Payload                                                                                                   |
|--------------|-----------------------------------------------------------------------------------------------------------|
| `MODBUS_TCP` | u8+bytes host, u16 port, u8 unit, then 4 × (u16 count, u16 start byte): discrete inputs → `%I` bits, coils ← `%Q` bits, input registers → `%IW`, holding registers ← `%QW`; u16 poll period (ms) |
| `GPIO_DI`    | u8 pin, u16 byte, u8 bit, u8 flags (bit0 invert, bit1 pull-up)                                           |
| `GPIO_DO`    | u8 pin, u16 byte, u8 bit, u8 flags (bit0 invert)                                                         |
| `GPIO_AI`    | u8 pin, u16 byte (word `%IW`)                                                                            |
| `GPIO_AO`    | u8 pin, u16 byte (word `%QW`)                                                                            |
| `IOLINK_MASTER` | u8+bytes host, u16 port, u8 unit, u16 poll period, u8 read function (3/4), u8 port count, then per port: u8 port, u16 PD in register, u16 `%I` byte, u8 PD in length, u16 PD out register, u16 `%Q` byte, u8 PD out length |
| `PROFINET_DEVICE` | u8+bytes interface, u8+bytes name of station, u16 vendor ID, u16 device ID, u16 `%I` byte, u16 `%I` length, u16 `%Q` byte, u16 `%Q` length (areas exchanged with the external IO-Controller) |
| `PROFINET_REMOTE` | u8+bytes interface, u8+bytes name of station, u8+bytes IP address, u16 vendor ID, u16 device ID, u16 update time (ms), u16 watchdog factor, u8 submodule count, then per submodule: u16 slot, u16 subslot, u32 module ident, u32 submodule ident, u16 input length, u16 `%I` byte, u16 output length, u16 `%Q` byte, u8 record count, then per parameter record: u16 index, u16 length, data |

A platform ignores (and reports) module kinds it does not support.

## Instructions

See `opcodes` in [`spec/isa.json`](../spec/isa.json): each entry lists its operands
(`u8`, `u16`, `u32`, `i32`, `i64`, `f64`) and its effect on the stack.
