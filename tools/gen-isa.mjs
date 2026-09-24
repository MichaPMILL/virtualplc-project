#!/usr/bin/env node
// Generates sdk/src/isa.ts and runtime/core/isa.h from spec/isa.json.
// Usage: node tools/gen-isa.mjs [--check]   (--check fails if the files are out of date)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isa = JSON.parse(readFileSync(join(root, 'spec/isa.json'), 'utf8'));
const header = 'Generated from spec/isa.json by tools/gen-isa.mjs - do not edit.';

const tsEnum = (name, map) =>
  `export const ${name} = {\n${Object.entries(map).map(([k, v]) => `  ${k}: ${typeof v === 'object' ? v.code : v},`).join('\n')}\n} as const;\n`;

const ts = [
  `// ${header}`,
  '',
  `export const ISA_VERSION = ${isa.version};`,
  `export const PROTOCOL_PORT = ${isa.protocol.port};`,
  '',
  tsEnum('Area', isa.areas),
  tsEnum('VmType', isa.types),
  `export const VM_TYPE_SIZE: Record<number, number> = {\n${Object.values(isa.types).map((t) => `  ${t.code}: ${t.size},`).join('\n')}\n};\n`,
  tsEnum('Op', isa.opcodes),
  `export const OPERANDS: Record<number, readonly string[]> = {\n${Object.values(isa.opcodes).map((o) => `  ${o.code}: [${o.operands.map((x) => `'${x.split(':')[0]}'`).join(', ')}],`).join('\n')}\n};\n`,
  `export const OP_NAMES: Record<number, string> = {\n${Object.entries(isa.opcodes).map(([k, o]) => `  ${o.code}: '${k}',`).join('\n')}\n};\n`,
  tsEnum('MathFn', isa.mathFunctions),
  tsEnum('StdFn', isa.stdFunctions),
  tsEnum('SysFn', isa.sysFunctions),
  tsEnum('Trap', isa.trapCodes),
  tsEnum('Section', isa.sections),
  tsEnum('IoModule', isa.ioModules),
  tsEnum('Command', isa.protocol.commands),
  tsEnum('Status', isa.protocol.status),
  tsEnum('CpuState', isa.protocol.states),
  'export interface LibraryBlockSpec {\n  code: number;\n  size: number;\n  members: Record<string, [string, number]>;\n  hidden: Record<string, [string, number]>;\n  init?: Record<string, number>;\n}\n',
  `export const LIBRARY_BLOCKS: Record<string, LibraryBlockSpec> = ${JSON.stringify(isa.libraryBlocks, null, 2)};\n`,
].join('\n');

const cEnum = (name, map, prefix) =>
  `enum class ${name} : uint8_t {\n${Object.entries(map).map(([k, v]) => `    ${prefix}${k} = ${typeof v === 'object' ? v.code : v},`).join('\n')}\n};\n`;

const libs = Object.entries(isa.libraryBlocks).map(([name, b]) => {
  const fields = { ...b.members, ...b.hidden };
  return `namespace lib_${name.toLowerCase()} {\n    constexpr uint32_t SIZE = ${b.size};\n${Object.entries(fields).map(([f, [, off]]) => `    constexpr uint32_t ${f.toUpperCase()} = ${off};`).join('\n')}\n}`;
}).join('\n');

const h = [
  `// ${header}`,
  '#pragma once',
  '#include <stdint.h>',
  '',
  'namespace vplc {',
  '',
  `constexpr uint16_t ISA_VERSION = ${isa.version};`,
  `constexpr uint16_t PROTOCOL_PORT = ${isa.protocol.port};`,
  '',
  cEnum('Area', isa.areas, ''),
  cEnum('VmType', isa.types, 'T_'),
  `constexpr uint8_t VM_TYPE_SIZE[] = {${Object.values(isa.types).map((t) => t.size).join(', ')}};\n`,
  cEnum('Op', isa.opcodes, 'OP_'),
  cEnum('MathFn', isa.mathFunctions, 'M_'),
  cEnum('StdFn', isa.stdFunctions, 'S_'),
  cEnum('SysFn', isa.sysFunctions, 'SYS_'),
  cEnum('Trap', isa.trapCodes, 'TRAP_'),
  cEnum('Section', isa.sections, 'SEC_'),
  cEnum('IoModule', isa.ioModules, 'IO_'),
  cEnum('Command', isa.protocol.commands, 'CMD_'),
  cEnum('Status', isa.protocol.status, 'ST_'),
  cEnum('CpuState', isa.protocol.states, 'CPU_'),
  cEnum('LibBlock', Object.fromEntries(Object.entries(isa.libraryBlocks).map(([k, v]) => [k, v.code])), 'LIB_'),
  libs,
  '',
  `// Size in bytes of the operands of an opcode (-1 = unknown opcode).\ninline int operandBytes(uint8_t op) {\n    switch (op) {\n${Object.values(isa.opcodes).map((o) => `        case ${o.code}: return ${o.operands.map((x) => ({ u8: 1, u16: 2, u32: 4, i32: 4, i64: 8, f64: 8 })[x.split(':')[0]]).reduce((a, b) => a + b, 0)};`).join('\n')}\n        default: return -1;\n    }\n}`,
  '',
  `inline const char* trapName(uint8_t code) {\n    switch (code) {\n${Object.entries(isa.trapCodes).map(([k, v]) => `        case ${v}: return "${k}";`).join('\n')}\n        default: return "UNKNOWN";\n    }\n}`,
  '',
  '}  // namespace vplc',
  '',
].join('\n');

const outputs = [[join(root, 'sdk/src/isa.ts'), ts], [join(root, 'runtime/core/isa.h'), h]];
if (process.argv.includes('--check')) {
  const stale = outputs.filter(([p, c]) => !existsSync(p) || readFileSync(p, 'utf8') !== c);
  if (stale.length) {
    console.error('Out of date: ' + stale.map(([p]) => p).join(', ') + ' (run node tools/gen-isa.mjs)');
    process.exit(1);
  }
} else {
  for (const [p, c] of outputs) writeFileSync(p, c);
  console.log('Generated ' + outputs.map(([p]) => p.replace(root + '/', '')).join(', '));
}
