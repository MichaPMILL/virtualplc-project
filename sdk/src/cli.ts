#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { compile } from './compiler.ts';
import { disassemble } from './disasm.ts';
import { readImage } from './image.ts';
import { Section } from './isa.ts';

const USAGE = `VirtualPLC SDK

Usage:
  vplc compile <file.scl>... [-o program.vplc] [--symbols symbols.json] [--hardware hw.json] [--disasm]
  vplc help
`;

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === 'compile') return compileCommand(rest);
  process.stdout.write(USAGE);
  return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
}

function compileCommand(args: string[]): number {
  const files: string[] = [];
  let out: string | undefined;
  let symbolsOut: string | undefined;
  let hardware: string | undefined;
  let disasm = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o') out = args[++i];
    else if (a === '--symbols') symbolsOut = args[++i];
    else if (a === '--hardware') hardware = args[++i];
    else if (a === '--disasm') disasm = true;
    else files.push(a);
  }
  if (files.length === 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  const result = compile({
    sources: files.map((f) => ({ file: f, text: readFileSync(f, 'utf8') })),
    name: basename(files[0]).replace(/\.[^.]+$/, ''),
    hardware: hardware ? JSON.parse(readFileSync(hardware, 'utf8')) : undefined,
  });
  for (const d of result.diagnostics) {
    const where = [d.file, d.line, d.column].filter((x) => x !== undefined).join(':');
    process.stderr.write(`${where ? where + ': ' : ''}${d.severity}: ${d.message}\n`);
  }
  if (!result.ok || !result.image) return 1;
  if (out) writeFileSync(out, result.image);
  if (symbolsOut) writeFileSync(symbolsOut, JSON.stringify(result.symbols, null, 2));
  if (disasm) process.stdout.write(disassemble(readImage(result.image).sections.get(Section.CODE)!).join('\n') + '\n');
  const s = result.stats;
  process.stderr.write(`OK program ${result.programId}: code ${s.code} B, data ${s.data} B, %I ${s.inputs} B, %Q ${s.outputs} B, %M ${s.memory} B\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
