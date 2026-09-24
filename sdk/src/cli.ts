#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { compile } from './compiler.ts';
import { disassemble } from './disasm.ts';
import { readImage } from './image.ts';
import { Section } from './isa.ts';
import { verifyTraceCertificate, type TraceCertificate } from './datalog.ts';

const USAGE = `VirtualPLC SDK

Usage:
  vplc compile <file.scl>... [-o program.vplc] [--symbols symbols.json] [--hardware hw.json] [--disasm]
  vplc verify <certificate.json> [--fingerprint "3f9a 12c0 ..."]   traceability certificate
  vplc help
`;

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === 'compile') return compileCommand(rest);
  if (command === 'verify') {
    void verifyCommand(rest).then((code) => (process.exitCode = code));
    return 0;
  }
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

/** Checks a traceability certificate (records of a data log signed by a CPU) */
async function verifyCommand(args: string[]): Promise<number> {
  const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--fingerprint');
  const fi = args.indexOf('--fingerprint');
  const fingerprint = fi >= 0 ? args[fi + 1] : undefined;
  if (!file) {
    process.stderr.write(USAGE);
    return 2;
  }
  const cert = JSON.parse(readFileSync(file, 'utf8')) as TraceCertificate;
  const r = await verifyTraceCertificate(cert, fingerprint);
  const range = cert.records.length ? `records ${cert.records[0].recordId} to ${cert.records[cert.records.length - 1].recordId}` : 'no record';
  process.stdout.write(`Data log '${cert.log}' of CPU '${cert.plc}' (${range})\nCPU key fingerprint: ${r.fingerprint ?? '?'}\n`);
  if (r.ok) {
    process.stdout.write(`OK: ${r.verified} record(s) signed by this CPU, none altered or removed${fingerprint ? '' : '\n(check the fingerprint with the producer: --fingerprint)'}\n`);
    return 0;
  }
  process.stdout.write(`INVALID: ${r.reason}\n`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
