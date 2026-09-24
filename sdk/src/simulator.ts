// Simulated CPU ("simulation mode" of the Studio): the portable C++ CPU core compiled to
// WebAssembly (runtime/wasm), run in this process in real time. Programs are downloaded,
// monitored and forced through the device protocol, exactly as with a real CPU; the simulated
// inputs %I are written by the Studio (nothing overwrites them).
import { readFile } from 'node:fs/promises';

export { isSimulatorHost } from './serial.ts';

interface Exports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  vplc_init(maxProgram: number, maxData: number): number;
  vplc_in(): number;
  vplc_feed(length: number): void;
  vplc_out(): number;
  vplc_out_len(): number;
  vplc_out_clear(): void;
  vplc_loop(): number;
}

const IN_CAPACITY = 64 * 1024;
let wasmPath: string | URL | null = null;

/** Location of vplc-sim.wasm (for bundled applications) */
export function setSimulatorWasm(path: string | URL): void {
  wasmPath = path;
}

export class SimulatedCpu {
  private readonly x: Exports;
  private readonly listeners = new Set<(data: Buffer) => void>();
  private timer: NodeJS.Timeout | null = null;
  readonly messages: string[] = [];

  private constructor(x: Exports) {
    this.x = x;
  }

  static async create(options: { maxProgram?: number; maxData?: number } = {}): Promise<SimulatedCpu> {
    const bytes = await readFile(wasmPath ?? new URL('../wasm/vplc-sim.wasm', import.meta.url));
    let sim: SimulatedCpu | null = null;
    let memory: WebAssembly.Memory | null = null;
    const text = (ptr: number) => {
      const b = new Uint8Array(memory!.buffer, ptr);
      return new TextDecoder().decode(b.subarray(0, b.indexOf(0)));
    };
    const wasi = new Proxy({}, { get: () => () => 52 /* ENOSYS */ });
    const { instance } = await WebAssembly.instantiate(bytes, {
      env: {
        host_now_ms: () => performance.now(),
        host_date_ms: () => Date.now(),
        host_tz_min: () => -new Date().getTimezoneOffset(),
        host_log: (ptr: number) => {
          sim?.messages.push(text(ptr));
          if (sim && sim.messages.length > 100) sim.messages.shift();
        },
      },
      wasi_snapshot_preview1: wasi,
    });
    const x = instance.exports as unknown as Exports;
    memory = x.memory;
    x._initialize?.();
    if (!x.vplc_init(options.maxProgram ?? 1 << 20, options.maxData ?? 16 << 20)) throw new Error('Simulated CPU: out of memory');
    sim = new SimulatedCpu(x);
    sim.schedule(0);
    return sim;
  }

  /** Runs the scans in real time (the timer does not keep the process alive) */
  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      let next = 10;
      try {
        next = this.x.vplc_loop();
      } catch (e) {
        this.messages.push(`Simulated CPU stopped: ${(e as Error).message}`);
        return;
      }
      this.schedule(Math.max(1, Math.min(next, 50)));
    }, ms);
    this.timer.unref?.();
  }

  /** A connection to the simulated CPU (byte stream of the device protocol) */
  connect(onData: (data: Buffer) => void): { write(data: Buffer): void; destroy(): void } {
    this.listeners.add(onData);
    return {
      write: (data) => this.feed(data, onData),
      destroy: () => this.listeners.delete(onData),
    };
  }

  private feed(data: Buffer, reply: (data: Buffer) => void): void {
    for (let off = 0; off < data.length; off += IN_CAPACITY) {
      const chunk = data.subarray(off, off + IN_CAPACITY);
      new Uint8Array(this.x.memory.buffer, this.x.vplc_in(), chunk.length).set(chunk);
      this.x.vplc_feed(chunk.length);
    }
    const n = this.x.vplc_out_len();
    if (n === 0) return;
    const out = Buffer.from(new Uint8Array(this.x.memory.buffer, this.x.vplc_out(), n));
    this.x.vplc_out_clear();
    setImmediate(() => reply(out));
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}

let shared: Promise<SimulatedCpu> | null = null;

/** The simulated CPU of this process (created on first use, kept with its program) */
export function simulator(): Promise<SimulatedCpu> {
  shared ??= SimulatedCpu.create().catch((e) => {
    shared = null;
    throw new Error(`The simulated CPU cannot start: ${(e as Error).message}`);
  });
  return shared;
}
