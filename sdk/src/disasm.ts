import { OP_NAMES, OPERANDS } from './isa.ts';

/** Human-readable listing of bytecode (for debugging and tests). */
export function disassemble(code: Uint8Array): string[] {
  const view = new DataView(code.buffer, code.byteOffset, code.byteLength);
  const out: string[] = [];
  let pc = 0;
  while (pc < code.length) {
    const op = code[pc];
    const name = OP_NAMES[op] ?? `?${op}`;
    const start = pc;
    pc++;
    const args: string[] = [];
    for (const kind of OPERANDS[op] ?? []) {
      switch (kind) {
        case 'u8': args.push(String(view.getUint8(pc))); pc += 1; break;
        case 'u16': args.push(String(view.getUint16(pc, true))); pc += 2; break;
        case 'u32': args.push(String(view.getUint32(pc, true))); pc += 4; break;
        case 'i32': {
          const v = view.getInt32(pc, true);
          pc += 4;
          args.push(name.startsWith('J') ? `${v} (->${pc + v})` : String(v));
          break;
        }
        case 'i64': args.push(String(view.getBigInt64(pc, true))); pc += 8; break;
        case 'f64': args.push(String(view.getFloat64(pc, true))); pc += 8; break;
      }
    }
    out.push(`${String(start).padStart(5)}  ${name}${args.length ? ' ' + args.join(', ') : ''}`);
  }
  return out;
}
