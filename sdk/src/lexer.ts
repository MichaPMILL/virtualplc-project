import type { Scope } from './ast.ts';
import { CompileError } from './diagnostics.ts';
import { parseTemporal, TEMPORAL_PREFIXES } from './literals.ts';

export type TokenType =
  | 'ident' | 'keyword' | 'int' | 'real' | 'time' | 'bool' | 'string' | 'address' | 'op' | 'eof'
  /** typed literal of a date, time, 64-bit duration or character: text = type (DATE, TOD, LTOD, DT, LDT, DTL, LTIME, CHAR, WCHAR) */
  | 'typed';

export interface Token {
  type: TokenType;
  /** Keyword / operator text (upper-case for keywords), identifier name, or literal text. */
  text: string;
  value?: number | boolean | string | bigint;
  scope?: Scope;
  line: number;
  column: number;
}

export const KEYWORDS = new Set([
  'VAR', 'VAR_GLOBAL', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP', 'END_VAR', 'CONSTANT', 'RETAIN', 'NON_RETAIN', 'AT',
  'FUNCTION', 'END_FUNCTION', 'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK', 'ORGANIZATION_BLOCK', 'END_ORGANIZATION_BLOCK',
  'DATA_BLOCK', 'END_DATA_BLOCK', 'TYPE', 'END_TYPE', 'STRUCT', 'END_STRUCT', 'BEGIN', 'REGION', 'END_REGION', 'ARRAY', 'OF',
  'DB', 'END_DB', 'FC', 'END_FC', 'BLOCK', 'END_BLOCK', 'HARDWARE', 'END_HARDWARE',
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF', 'CASE', 'END_CASE', 'FOR', 'TO', 'BY', 'DO', 'END_FOR',
  'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT', 'EXIT', 'CONTINUE', 'RETURN',
  'AND', 'OR', 'XOR', 'NOT', 'MOD',
  // object orientation (METHOD, INTERFACE, CLASS, EXTENDS, ... are contextual identifiers)
  'END_METHOD', 'END_INTERFACE', 'END_CLASS',
]);

const TWO_CHAR = new Set([':=', '=>', '+=', '-=', '*=', '/=', '**', '<>', '<=', '>=', '..']);
const ONE_CHAR = new Set([';', ':', '.', '<', '>', ',', '(', ')', '[', ']', '+', '-', '*', '/', '=', '&']);
const TYPED_PREFIXES = new Set(['BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD', 'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'REAL', 'LREAL']);
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isAlpha = (c: string | undefined) => c !== undefined && /[\p{L}_]/u.test(c);
const isAlnum = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/** Integer value of a literal: a number when exact, a bigint beyond Number.MAX_SAFE_INTEGER (64-bit types). */
export function intLiteral(digits: string, base: 2 | 8 | 10 | 16): number | bigint {
  const prefix = { 2: '0b', 8: '0o', 10: '', 16: '0x' }[base];
  const value = BigInt(prefix + (base === 10 ? digits.replace(/^0+(?=\d)/, '') : digits));
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

/**
 * SCL lexer (IEC 61131-3):
 * comments `//`, `(* *)`, `/* *\/`, pragmas `{ }`, "quoted" and #local identifiers,
 * based integers (16#FF), reals, typed literals (T#1s, INT#5), addresses (%I0.0, %MW10).
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let col = 1;

  const peek = (o = 0) => source[pos + o];
  const advance = (n = 1) => {
    for (let i = 0; i < n && pos < source.length; i++) {
      if (source[pos] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      pos++;
    }
  };
  const consumeWhile = (pred: (c: string) => boolean) => {
    const start = pos;
    while (pos < source.length && pred(source[pos])) advance();
    return source.slice(start, pos);
  };
  const skipUntil = (terminator: string, open: number, error: string) => {
    const l = line;
    const c = col;
    const end = source.indexOf(terminator, pos + open);
    if (end < 0) throw new CompileError(error, l, c);
    advance(end + terminator.length - pos);
  };

  const readBased = (base: number, l: number, c: number): number | bigint => {
    if (![2, 8, 16].includes(base)) throw new CompileError(`Unsupported numeric base ${base}`, l, c);
    advance(); // #
    const raw = consumeWhile((ch) => /[0-9A-Fa-f_]/.test(ch));
    const clean = raw.replaceAll('_', '');
    const valid = { 2: /^[01]+$/, 8: /^[0-7]+$/, 16: /^[0-9a-fA-F]+$/ }[base as 2 | 8 | 16];
    if (!valid.test(clean)) throw new CompileError(`Invalid base-${base} literal '${raw}'`, l, c);
    return intLiteral(clean, base as 2 | 8 | 16);
  };

  const readNumber = (l: number, c: number): Token => {
    const digits = consumeWhile((ch) => isDigit(ch) || ch === '_');
    if (peek() === '#') {
      const value = readBased(parseInt(digits.replaceAll('_', ''), 10), l, c);
      return { type: 'int', text: String(value), value, line: l, column: c };
    }
    let text = digits.replaceAll('_', '');
    let real = false;
    if (peek() === '.' && isDigit(peek(1))) {
      advance();
      text += '.' + consumeWhile((ch) => isDigit(ch) || ch === '_').replaceAll('_', '');
      real = true;
    }
    if ((peek() === 'e' || peek() === 'E') && (isDigit(peek(1)) || ((peek(1) === '+' || peek(1) === '-') && isDigit(peek(2))))) {
      text += 'e' + peek(1);
      advance(2);
      text += consumeWhile(isDigit);
      real = true;
    }
    const value = real ? Number(text) : intLiteral(text, 10);
    return { type: real ? 'real' : 'int', text, value, line: l, column: c };
  };

  const readDuration = (l: number, c: number): number => {
    const raw = consumeWhile((ch) => isAlnum(ch) || ch === '.' || ch === '-');
    let text = raw.replaceAll('_', '').toLowerCase();
    const negative = text.startsWith('-');
    text = text.replace(/^-/, '');
    const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/g)];
    if (text === '' || parts.map((p) => p[0]).join('') !== text) {
      throw new CompileError(`Invalid time literal 'T#${raw}'`, l, c);
    }
    const factor: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
    const ms = parts.reduce((sum, p) => sum + Number(p[1]) * factor[p[2]], 0);
    return Math.round(negative ? -ms : ms);
  };

  const readString = (): string => {
    const l = line;
    const c = col;
    advance();
    let result = '';
    while (pos < source.length) {
      const ch = source[pos];
      if (ch === "'") {
        advance();
        return result;
      }
      if (ch === '\n') break;
      if (ch === '$') {
        const e = (peek(1) ?? '').toUpperCase();
        const map: Record<string, string> = { "'": "'", $: '$', N: '\n', L: '\n', R: '\r', T: '\t' };
        if (!(e in map)) throw new CompileError(`Invalid escape sequence '$${peek(1) ?? ''}'`, line, col);
        result += map[e];
        advance(2);
        continue;
      }
      result += ch;
      advance();
    }
    throw new CompileError('Unterminated string literal', l, c);
  };

  const readAddress = (l: number, c: number): string => {
    advance(); // %
    let raw = consumeWhile(isAlnum).toUpperCase();
    if (peek() === '.' && isDigit(peek(1))) {
      advance();
      raw += '.' + consumeWhile(isDigit);
    }
    let m = /^([IQM])X?(\d+)\.([0-7])$/.exec(raw);
    if (m) return `${m[1]}${m[2]}.${m[3]}`;
    m = /^([IQM])([BWD])(\d+)$/.exec(raw);
    if (m) return `${m[1]}${m[2]}${m[3]}`;
    throw new CompileError(`Invalid address '%${raw}' (expected e.g. %I0.0, %QW2, %MD10)`, l, c);
  };

  const next = (): Token => {
    // whitespace, comments, pragmas
    for (;;) {
      const ch = peek();
      if (ch === undefined) break;
      if (/\s/.test(ch)) advance();
      else if (ch === '/' && peek(1) === '/') consumeWhile((x) => x !== '\n');
      else if (ch === '(' && peek(1) === '*') skipUntil('*)', 2, 'Unterminated comment');
      else if (ch === '/' && peek(1) === '*') skipUntil('*/', 2, 'Unterminated comment');
      else if (ch === '{') skipUntil('}', 1, 'Unterminated pragma');
      else break;
    }
    const l = line;
    const c = col;
    const ch = peek();
    if (ch === undefined) return { type: 'eof', text: '', line: l, column: c };

    if (isDigit(ch)) return readNumber(l, c);
    if (ch === "'") {
      const value = readString();
      return { type: 'string', text: value, value, line: l, column: c };
    }
    if (ch === '"') {
      advance();
      const name = consumeWhile((x) => x !== '"' && x !== '\n');
      if (peek() !== '"') throw new CompileError('Unterminated quoted identifier', l, c);
      advance();
      if (name.trim() === '') throw new CompileError('Empty quoted identifier', l, c);
      return { type: 'ident', text: name, scope: 'global', line: l, column: c };
    }
    if (ch === '#' && isAlpha(peek(1))) {
      advance();
      return { type: 'ident', text: consumeWhile(isAlnum), scope: 'local', line: l, column: c };
    }
    if (ch === '%') {
      return { type: 'address', text: readAddress(l, c), line: l, column: c };
    }
    if (isAlpha(ch)) {
      const word = consumeWhile(isAlnum);
      const upper = word.toUpperCase();
      if (peek() === '#') {
        if (upper === 'T' || upper === 'TIME') {
          advance();
          const value = readDuration(l, c);
          return { type: 'time', text: String(value), value, line: l, column: c };
        }
        const temporal = TEMPORAL_PREFIXES[upper];
        if (temporal) {
          advance();
          const raw = consumeWhile((x) => isAlnum(x) || x === '-' || x === ':' || x === '.');
          const value = parseTemporal(temporal, raw);
          if (value === null) throw new CompileError(`Invalid ${upper}# literal '${raw}'`, l, c);
          return { type: 'typed', text: temporal, value, line: l, column: c };
        }
        if (upper === 'CHAR' || upper === 'WCHAR' || upper === 'STRING' || upper === 'WSTRING') {
          advance();
          const tok = next();
          if (upper.endsWith('STRING')) {
            if (tok.type !== 'string') throw new CompileError(`Invalid ${upper}# literal`, l, c);
            return { ...tok, line: l, column: c };
          }
          const code = tok.type === 'string' && typeof tok.value === 'string' && [...tok.value].length === 1 ? tok.value.codePointAt(0)!
            : tok.type === 'int' && typeof tok.value === 'number' ? tok.value : -1;
          if (code < 0 || code > (upper === 'CHAR' ? 255 : 65535)) throw new CompileError(`Invalid ${upper}# literal`, l, c);
          return { type: 'typed', text: upper, value: BigInt(code), line: l, column: c };
        }
        if (TYPED_PREFIXES.has(upper)) {
          advance();
          const negative = peek() === '-';
          if (negative) advance();
          const tok = next();
          if ((tok.type === 'int' || tok.type === 'real') && (typeof tok.value === 'number' || typeof tok.value === 'bigint')) {
            const value = negative ? -tok.value : tok.value;
            return { ...tok, text: String(value), value, line: l, column: c };
          }
          if (tok.type === 'bool' && !negative) return { ...tok, line: l, column: c };
          throw new CompileError(`Invalid ${upper}# literal`, l, c);
        }
      }
      if (upper === 'TRUE' || upper === 'FALSE') {
        return { type: 'bool', text: upper, value: upper === 'TRUE', line: l, column: c };
      }
      if (upper === 'REGION') {
        // the title of a region is free text (apostrophes, quotes…)
        while (source[pos] !== undefined && source[pos] !== '\n' && source[pos] !== '\r') advance();
      }
      if (KEYWORDS.has(upper)) return { type: 'keyword', text: upper, line: l, column: c };
      return { type: 'ident', text: word, scope: null, line: l, column: c };
    }
    const two = ch + (peek(1) ?? '');
    if (TWO_CHAR.has(two)) {
      advance(2);
      return { type: 'op', text: two, line: l, column: c };
    }
    if (ONE_CHAR.has(ch)) {
      advance();
      return ch === '&' ? { type: 'keyword', text: 'AND', line: l, column: c } : { type: 'op', text: ch, line: l, column: c };
    }
    throw new CompileError(`Unexpected character '${ch}'`, l, c);
  };

  for (;;) {
    const t = next();
    tokens.push(t);
    if (t.type === 'eof') return tokens;
  }
}

export function describeToken(t: Token): string {
  switch (t.type) {
    case 'ident':
      return `identifier '${t.scope === 'global' ? `"${t.text}"` : t.scope === 'local' ? `#${t.text}` : t.text}'`;
    case 'int':
    case 'real':
      return `number ${t.text}`;
    case 'time':
      return 'time literal';
    case 'typed':
      return `${t.text} literal`;
    case 'bool':
      return t.text;
    case 'string':
      return `string '${t.text}'`;
    case 'address':
      return `address %${t.text}`;
    case 'eof':
      return 'end of input';
    default:
      return `'${t.text}'`;
  }
}
