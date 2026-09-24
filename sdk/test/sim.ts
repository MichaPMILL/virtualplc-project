// Drives runtime/build/vplc-sim (C++ VM) from tests.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { compile, type CompileResult } from '../src/compiler.ts';
import type { IoModuleConfig } from '../src/image.ts';
import { findSymbol } from '../src/symbols.ts';
import { decodeValue, encodeValue, type PlcValue } from '../src/values.ts';

export const SIM = new URL('../../runtime/build/vplc-sim', import.meta.url).pathname;
export const simAvailable = existsSync(SIM);

export class Sim {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly lines: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  stderr = '';
  readonly result: CompileResult;

  private constructor(result: CompileResult, watchdogMs: number) {
    this.result = result;
    this.proc = spawn(SIM, [String(watchdogMs)]);
    this.proc.stderr.on('data', (d) => (this.stderr += d));
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      const w = this.waiters.shift();
      if (w) w(line);
      else this.lines.push(line);
    });
  }

  static async start(source: string, options: { hardware?: IoModuleConfig[]; cycleMs?: number; autostart?: boolean; watchdogMs?: number } = {}): Promise<Sim> {
    const result = compile({ sources: [{ file: 'test.scl', text: source }], hardware: options.hardware, cycleMs: options.cycleMs, buildTime: 0 });
    if (!result.ok || !result.image) {
      throw new Error('Compilation failed:\n' + result.diagnostics.map((d) => `${d.line}: ${d.message}`).join('\n'));
    }
    const sim = new Sim(result, options.watchdogMs ?? 0);
    const file = join(mkdtempSync(join(tmpdir(), 'vplc-')), 'program.vplc');
    writeFileSync(file, result.image);
    await sim.ok(`load ${file}`);
    if (options.autostart !== false) await sim.ok('start');
    return sim;
  }

  command(line: string): Promise<string> {
    return new Promise((resolve) => {
      const queued = this.lines.shift();
      if (queued !== undefined) resolve(queued);
      else this.waiters.push(resolve);
      this.proc.stdin.write(line + '\n');
    });
  }

  async ok(line: string): Promise<string> {
    const r = await this.command(line);
    if (!r.startsWith('OK')) throw new Error(`${line} -> ${r}\n${this.stderr}`);
    return r.slice(3);
  }

  async scan(count = 1, ms?: number): Promise<void> {
    await this.ok(`scan ${count}${ms !== undefined ? ` ${ms}` : ''}`);
  }

  private symbol(path: string) {
    const s = findSymbol(this.result.symbols, path);
    if (!s) throw new Error(`Unknown symbol ${path}`);
    return s;
  }

  async get(path: string): Promise<PlcValue> {
    const s = this.symbol(path);
    const hex = await this.ok(`read ${s.area} ${s.offset} ${s.size}`);
    return decodeValue(s, Uint8Array.from(Buffer.from(hex, 'hex')));
  }

  async set(path: string, value: PlcValue): Promise<void> {
    const s = this.symbol(path);
    if (s.bit !== undefined) await this.ok(`bit ${s.area} ${s.offset} ${s.bit} ${value ? 1 : 0}`);
    else await this.ok(`write ${s.area} ${s.offset} ${Buffer.from(encodeValue(s, value)).toString('hex')}`);
  }

  /** Raw process image access: area I/Q/M, e.g. bit('I', 0, 1, true) */
  async bit(area: 'I' | 'Q' | 'M', byte: number, bit: number, value?: boolean): Promise<boolean> {
    if (value !== undefined) {
      await this.ok(`bit ${area} ${byte} ${bit} ${value ? 1 : 0}`);
      return value;
    }
    const hex = await this.ok(`read ${area} ${byte} 1`);
    return ((parseInt(hex, 16) >> bit) & 1) === 1;
  }

  async state(): Promise<Record<string, unknown>> {
    return JSON.parse(await this.ok('state'));
  }

  async logs(): Promise<Array<{ msg: string }>> {
    return JSON.parse(await this.ok('logs'));
  }

  close(): void {
    this.proc.stdin.end('quit\n');
  }
}

export async function withSim(source: string, fn: (sim: Sim) => Promise<void>, options?: Parameters<typeof Sim.start>[1]): Promise<void> {
  const sim = await Sim.start(source, options);
  try {
    await fn(sim);
  } finally {
    sim.close();
  }
}
