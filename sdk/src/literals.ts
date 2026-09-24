// Typed literals of dates, times and durations (D#, TOD#, LTOD#, DT#, LDT#, DTL#, LT#),
// shared by the compiler, the monitoring (formatting) and the Studio (value input).
// Representations (same as the VM):
//   DATE  days since 1990-01-01            TOD   ms since midnight
//   LTOD  ns since midnight                LTIME ns (duration)
//   LDT   ns since 1970-01-01 (UTC or local, as the program uses it)
//   DT    8 BCD bytes: yy mm dd hh mi ss ms(3 digits) weekday (1 = Sunday)
//   DTL   structure (year, month, day, weekday, hour, minute, second, nanosecond)

export type TemporalType = 'DATE' | 'TOD' | 'LTOD' | 'DT' | 'LDT' | 'DTL' | 'LTIME';

export const TEMPORAL_PREFIXES: Record<string, TemporalType> = {
  D: 'DATE', DATE: 'DATE',
  TOD: 'TOD', TIME_OF_DAY: 'TOD',
  LTOD: 'LTOD', LTIME_OF_DAY: 'LTOD',
  DT: 'DT', DATE_AND_TIME: 'DT',
  LDT: 'LDT', DATE_AND_LTIME: 'LDT',
  DTL: 'DTL',
  LT: 'LTIME', LTIME: 'LTIME',
};

const NS_PER_DAY = 86_400_000_000_000n;
const DAYS_1970_TO_1990 = 7305;

export function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z: number): { year: number; month: number; day: number; weekday: number } {
  const weekday = ((((z % 7) + 7) % 7) + 4) % 7 + 1; // 1970-01-01 was a Thursday; 1 = Sunday
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day, weekday };
}

/** "12:30:15.25" -> ns since midnight */
function timeOfDay(text: string): bigint | null {
  const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,9}))?)?$/.exec(text);
  if (!m) return null;
  const [h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return null;
  const frac = BigInt((m[4] ?? '').padEnd(9, '0'));
  return BigInt(h) * 3_600_000_000_000n + BigInt(mi) * 60_000_000_000n + BigInt(s) * 1_000_000_000n + frac;
}

/** "2024-01-15" -> days since 1970 */
function date(text: string): number | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const days = daysFromCivil(y, mo, d);
  return civilFromDays(days).month === mo ? days : null; // rejects 2023-02-30
}

/** "2024-01-15-12:30:00.5" -> ns since 1970 */
function dateTime(text: string): bigint | null {
  const m = /^(\d{4}-\d{1,2}-\d{1,2})-(.+)$/.exec(text);
  if (!m) return null;
  const d = date(m[1]);
  const t = timeOfDay(m[2]);
  return d === null || t === null ? null : BigInt(d) * NS_PER_DAY + t;
}

/** "1d2h3m4s5ms6us7ns" (optionally negative) -> ns */
export function parseDurationNs(text: string): bigint | null {
  let t = text.replaceAll('_', '').toLowerCase();
  const negative = t.startsWith('-');
  t = t.replace(/^-/, '');
  const parts = [...t.matchAll(/(\d+(?:\.\d+)?)(ms|us|ns|d|h|m|s)/g)];
  if (!t || parts.map((p) => p[0]).join('') !== t) return null;
  const unit: Record<string, bigint> = { d: NS_PER_DAY, h: 3_600_000_000_000n, m: 60_000_000_000n, s: 1_000_000_000n, ms: 1_000_000n, us: 1000n, ns: 1n };
  let ns = 0n;
  for (const p of parts) {
    const [int, frac = ''] = p[1].split('.');
    ns += BigInt(int) * unit[p[2]] + (frac ? (BigInt(frac.padEnd(18, '0').slice(0, 18)) * unit[p[2]]) / 10n ** 18n : 0n);
  }
  return negative ? -ns : ns;
}

function toBcd(v: number): number {
  return ((Math.floor(v / 10) % 10) << 4) | (v % 10);
}

/** LDT (ns since 1970) -> DATE_AND_TIME (BCD) as an unsigned 64-bit value */
export function ldtToDt(ns: bigint): bigint {
  const days = Number(ns >= 0n ? ns / NS_PER_DAY : -((-ns + NS_PER_DAY - 1n) / NS_PER_DAY));
  const rest = ns - BigInt(days) * NS_PER_DAY;
  const c = civilFromDays(days);
  const ms = Number(rest / 1_000_000n);
  const bytes = [
    toBcd(c.year % 100), toBcd(c.month), toBcd(c.day), toBcd(Math.floor(ms / 3_600_000)), toBcd(Math.floor(ms / 60_000) % 60),
    toBcd(Math.floor(ms / 1000) % 60), toBcd(Math.floor((ms % 1000) / 10)), ((ms % 10) << 4) | c.weekday,
  ];
  return bytes.reduce((v, b) => (v << 8n) | BigInt(b), 0n);
}

/** DATE_AND_TIME (BCD) -> LDT (ns since 1970) */
export function dtToLdt(bcd: bigint): bigint {
  const b = Array.from({ length: 8 }, (_, i) => Number((bcd >> BigInt(56 - i * 8)) & 0xffn));
  const un = (x: number) => (x >> 4) * 10 + (x & 15);
  const yy = un(b[0]);
  const days = daysFromCivil(yy >= 90 ? 1900 + yy : 2000 + yy, un(b[1]), un(b[2]));
  const ms = un(b[6]) * 10 + (b[7] >> 4);
  return BigInt(days) * NS_PER_DAY + BigInt(((un(b[3]) * 60 + un(b[4])) * 60 + un(b[5])) * 1000 + ms) * 1_000_000n;
}

/**
 * Value of a typed literal after its prefix (e.g. prefix "D", text "2024-01-15"), in the
 * representation of the type (see above; DTL literals give an LDT). Null if invalid.
 */
export function parseTemporal(type: TemporalType, text: string): bigint | null {
  switch (type) {
    case 'DATE': {
      const d = date(text);
      return d === null || d < DAYS_1970_TO_1990 || d - DAYS_1970_TO_1990 > 65378 ? null : BigInt(d - DAYS_1970_TO_1990);
    }
    case 'TOD': {
      const t = timeOfDay(text);
      return t === null ? null : t / 1_000_000n;
    }
    case 'LTOD':
      return timeOfDay(text);
    case 'LDT':
    case 'DTL':
      return dateTime(text);
    case 'DT': {
      const ns = dateTime(text);
      if (ns === null) return null;
      const year = civilFromDays(Number(ns / NS_PER_DAY)).year;
      return year < 1990 || year > 2089 ? null : ldtToDt(ns);
    }
    case 'LTIME':
      return parseDurationNs(text);
  }
}

// ---------------------------------------------------------------------------
// Formatting (monitoring)
// ---------------------------------------------------------------------------

const pad = (n: number | bigint, w = 2) => String(n).padStart(w, '0');

function formatClock(ns: bigint, digits: number): string {
  const s = ns / 1_000_000_000n;
  const frac = ns % 1_000_000_000n;
  const base = `${pad(s / 3600n)}:${pad((s / 60n) % 60n)}:${pad(s % 60n)}`;
  return digits ? `${base}.${pad(frac, 9).slice(0, digits)}` : base;
}

function formatDateTime(ns: bigint, digits: number): string {
  const days = Number(ns >= 0n ? ns / NS_PER_DAY : -((-ns + NS_PER_DAY - 1n) / NS_PER_DAY));
  const c = civilFromDays(days);
  return `${c.year}-${pad(c.month)}-${pad(c.day)}-${formatClock(ns - BigInt(days) * NS_PER_DAY, digits)}`;
}

export function formatTemporal(type: TemporalType, value: bigint | number): string {
  const v = BigInt(value);
  switch (type) {
    case 'DATE': {
      const c = civilFromDays(Number(v) + DAYS_1970_TO_1990);
      return `D#${c.year}-${pad(c.month)}-${pad(c.day)}`;
    }
    case 'TOD': return `TOD#${formatClock(v * 1_000_000n, 3)}`;
    case 'LTOD': return `LTOD#${formatClock(v, 9)}`;
    case 'LDT': return `LDT#${formatDateTime(v, 9)}`;
    case 'DTL': return `DTL#${formatDateTime(v, 9)}`;
    case 'DT': return `DT#${formatDateTime(dtToLdt(BigInt.asUintN(64, v)), 3)}`;
    case 'LTIME': {
      let n = v < 0n ? -v : v;
      const parts: string[] = [];
      for (const [unit, size] of [['D', NS_PER_DAY], ['H', 3_600_000_000_000n], ['M', 60_000_000_000n], ['S', 1_000_000_000n], ['MS', 1_000_000n], ['US', 1000n], ['NS', 1n]] as const) {
        if (n >= size) {
          parts.push(`${n / size}${unit}`);
          n %= size;
        }
      }
      return `LT#${v < 0n ? '-' : ''}${parts.join('_') || '0NS'}`;
    }
  }
}
