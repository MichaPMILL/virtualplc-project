import type { Address, CallArg, DataBlock, Expr, Pou, PouKind, Program, Section, Stmt, TypeRef, UserType, VarDecl } from './ast.ts';
import { CompileError } from './diagnostics.ts';
import { describeToken, tokenize, type Token } from './lexer.ts';

const HEADER_ITEMS = new Set(['VERSION', 'TITLE', 'AUTHOR', 'FAMILY', 'NAME', 'KNOW_HOW_PROTECT']);
const PRECEDENCE: string[][] = [
  ['OR'],
  ['XOR'],
  ['AND'],
  ['=', '<>', '<', '<=', '>', '>='],
  ['+', '-'],
  ['*', '/', 'MOD'],
  ['**'],
];
const COMPOUND: Record<string, string> = { '+=': '+', '-=': '-', '*=': '*', '/=': '/' };

export function parseAddress(text: string): Address | null {
  const t = text.trim().replace(/^%/, '').toUpperCase();
  let m = /^([IQM])X?(\d{1,5})\.([0-7])$/.exec(t);
  if (m) return { area: m[1] as Address['area'], size: 'X', byte: Number(m[2]), bit: Number(m[3]) };
  m = /^([IQM])([BWD])(\d{1,5})$/.exec(t);
  if (m) return { area: m[1] as Address['area'], size: m[2] as Address['size'], byte: Number(m[3]), bit: 0 };
  return null;
}

export function formatAddress(a: Address): string {
  return a.size === 'X' ? `%${a.area}${a.byte}.${a.bit}` : `%${a.area}${a.size}${a.byte}`;
}

/**
 * Parses SCL source: external sources (ORGANIZATION_BLOCK, FUNCTION_BLOCK,
 * FUNCTION, DATA_BLOCK, VAR_GLOBAL) and the historical VirtualPLC sections
 * (VAR, DB, BLOCK, FC). Throws CompileError on the first syntax error.
 */
export function parse(source: string, file?: string): Program {
  try {
    return new Parser(tokenize(source), file).program();
  } catch (e) {
    if (e instanceof CompileError && file !== undefined && e.file === undefined) e.file = file;
    throw e;
  }
}

class Parser {
  private i = 0;
  private readonly tokens: Token[];
  private readonly file: string | undefined;

  constructor(tokens: Token[], file?: string) {
    this.tokens = tokens;
    this.file = file;
  }

  program(): Program {
    const prog: Program = { vars: [], pous: [], dataBlocks: [], types: [] };
    let startup: Stmt[] | null = null;

    while (!this.at('eof')) {
      const t = this.cur();
      const kw = t.type === 'keyword' ? t.text : '';
      switch (kw) {
        case 'VAR':
        case 'VAR_GLOBAL':
          prog.vars.push(...this.varSection('global'));
          break;
        case 'FUNCTION':
          prog.pous.push(this.pou('FUNCTION', 'END_FUNCTION'));
          break;
        case 'FUNCTION_BLOCK':
          prog.pous.push(this.pou('FUNCTION_BLOCK', 'END_FUNCTION_BLOCK'));
          break;
        case 'ORGANIZATION_BLOCK':
          prog.pous.push(this.pou('ORGANIZATION_BLOCK', 'END_ORGANIZATION_BLOCK'));
          break;
        case 'DATA_BLOCK':
          prog.dataBlocks.push(this.dataBlock());
          break;
        case 'TYPE':
          prog.types.push(...this.userTypes());
          break;
        case 'FC': {
          // Historical main program -> cyclic OB "Main"
          this.next();
          const body = this.statements(['END_FC']);
          this.close('END_FC');
          prog.pous.push({ kind: 'ORGANIZATION_BLOCK', name: 'Main', returnType: null, vars: [], body, line: t.line, file: this.file });
          break;
        }
        case 'BLOCK': {
          this.next();
          const name = this.expectIdent().text;
          const body = this.statements(['END_BLOCK']);
          this.close('END_BLOCK');
          prog.pous.push({ kind: 'FUNCTION', name, returnType: null, vars: [], body, line: t.line, file: this.file });
          break;
        }
        case 'DB': {
          // Historical start values -> Startup OB
          this.next();
          startup = [...(startup ?? []), ...this.statements(['END_DB'])];
          this.close('END_DB');
          break;
        }
        case 'HARDWARE':
          throw this.error('HARDWARE sections are not supported by the compiled runtime: declare I/O modules in the device configuration and use %I/%Q addresses', t);
        default:
          throw this.unexpected('a block (ORGANIZATION_BLOCK, FUNCTION_BLOCK, FUNCTION, DATA_BLOCK), a TYPE or VAR_GLOBAL');
      }
    }
    if (startup !== null) {
      prog.pous.push({ kind: 'ORGANIZATION_BLOCK', name: 'Startup', returnType: null, vars: [], body: startup, line: startup[0]?.line ?? 1, file: this.file });
    }
    return prog;
  }

  // ---------------------------------------------------------------- blocks

  private pou(kind: PouKind, end: string): Pou {
    const start = this.next();
    const name = this.expectIdent().text;
    let returnType: TypeRef | null = null;
    if (kind === 'FUNCTION' && this.accept(':')) {
      returnType = this.type();
      if (returnType.name === 'VOID') returnType = null;
    }
    this.skipHeader();
    const vars: VarDecl[] = [];
    for (;;) {
      const t = this.cur();
      let section: Section | null =
        t.text === 'VAR_INPUT' ? 'input'
          : t.text === 'VAR_OUTPUT' ? 'output'
            : t.text === 'VAR_IN_OUT' ? 'inout'
              : t.text === 'VAR_TEMP' ? 'temp'
                : t.text === 'VAR' ? 'static' : null;
      if (t.type !== 'keyword' || section === null) break;
      if (section === 'static' && kind !== 'FUNCTION_BLOCK' && this.peek(1).text !== 'CONSTANT') section = 'temp';
      vars.push(...this.varSection(section));
    }
    this.acceptKeyword('BEGIN');
    const body = this.statements([end]);
    this.close(end);
    return { kind, name, returnType, vars, body, line: start.line, file: this.file };
  }

  private dataBlock(): DataBlock {
    const start = this.next();
    const name = this.expectIdent().text;
    this.skipHeader();
    let instanceOf: string | null = null;
    let fields: VarDecl[] = [];
    if (this.cur().type === 'ident') {
      instanceOf = this.next().text;
    } else if (this.acceptKeyword('STRUCT')) {
      fields = this.declarations('static', ['END_STRUCT']);
      this.close('END_STRUCT');
    } else {
      while (this.isKeyword('VAR')) fields.push(...this.varSection('static'));
    }
    let init: Stmt[] = [];
    if (this.acceptKeyword('BEGIN')) init = this.statements(['END_DATA_BLOCK']);
    this.close('END_DATA_BLOCK');
    return { name, instanceOf, fields, init, line: start.line, file: this.file };
  }

  /** TYPE "Name" [header] STRUCT ... END_STRUCT[;] END_TYPE (several types may share one TYPE section). */
  private userTypes(): UserType[] {
    this.next();
    const out: UserType[] = [];
    do {
      const name = this.expectIdent();
      this.accept(':');
      this.skipHeader();
      this.expectKeyword('STRUCT');
      const fields = this.declarations('static', ['END_STRUCT']);
      this.close('END_STRUCT');
      out.push({ name: name.text, fields, line: name.line, file: this.file });
    } while (!this.isKeyword('END_TYPE') && !this.at('eof'));
    this.close('END_TYPE');
    return out;
  }

  private skipHeader(): void {
    for (;;) {
      const t = this.cur();
      if (t.type === 'ident' && t.scope === null && HEADER_ITEMS.has(t.text.toUpperCase()) && [':', '='].includes(this.peek(1).text)) {
        this.skipLine(t.line);
      } else if (t.type === 'keyword' && (t.text === 'NON_RETAIN' || t.text === 'RETAIN')) {
        this.next();
      } else {
        return;
      }
    }
  }

  private skipLine(line: number): void {
    while (!this.at('eof') && this.cur().line === line) this.next();
  }

  private varSection(section: Section): VarDecl[] {
    this.next();
    while (this.isKeyword('CONSTANT') || this.isKeyword('RETAIN') || this.isKeyword('NON_RETAIN')) {
      if (this.next().text === 'CONSTANT') section = 'constant';
    }
    const vars = this.declarations(section, ['END_VAR']);
    this.close('END_VAR');
    return vars;
  }

  private declarations(section: Section, terminators: string[]): VarDecl[] {
    const vars: VarDecl[] = [];
    while (!terminators.includes(this.cur().text) || this.cur().type !== 'keyword') {
      if (this.at('eof')) throw this.unexpected(`'${terminators[0]}'`);
      const names = [this.expectIdent()];
      while (this.accept(',')) names.push(this.expectIdent());
      let address: Address | null = null;
      if (this.acceptKeyword('AT')) {
        const t = this.expect('address');
        address = parseAddress(t.text);
        if (names.length > 1) throw this.error('An address can only be given to a single variable', t);
      }
      this.expectOp(':');
      if (this.cur().type === 'ident' && this.peek(1).text === '.' && section === 'global') {
        throw this.error("I/O bindings like 'Device.INPUT.0' are replaced by addresses: use 'Name AT %I0.0 : Bool;'", this.cur());
      }
      const type = this.type();
      const initial = this.accept(':=') ? this.expression() : null;
      this.expectOp(';');
      for (const n of names) {
        vars.push({ name: n.text, type, initial, address, section, line: n.line, file: this.file });
      }
    }
    return vars;
  }

  private type(): TypeRef {
    const t = this.cur();
    if (this.acceptKeyword('ARRAY')) {
      this.expectOp('[');
      const low = this.signedInt();
      this.expectOp('..');
      const high = this.signedInt();
      this.expectOp(']');
      this.expectKeyword('OF');
      if (high < low || high - low >= 65536) throw this.error(`Invalid array bounds [${low}..${high}]`, t);
      return { name: 'ARRAY', element: this.type(), low, high, line: t.line };
    }
    if (this.acceptKeyword('STRUCT')) {
      const fields = this.declarations('static', ['END_STRUCT']);
      this.expectKeyword('END_STRUCT');
      return { name: 'STRUCT', fields, line: t.line };
    }
    const id = this.expectIdent();
    const upper = id.text.toUpperCase();
    const aliases: Record<string, string> = {
      IEC_TIMER: 'TON', TON_TIME: 'TON', TOF_TIME: 'TOF', TP_TIME: 'TP', IEC_COUNTER: 'CTUD',
      IEC_LTIMER: 'TON', TON_LTIME: 'TON', TOF_LTIME: 'TOF', TP_LTIME: 'TP',
      TIME_OF_DAY: 'TOD', LTIME_OF_DAY: 'LTOD', DATE_AND_TIME: 'DT', DATE_AND_LTIME: 'LDT',
      // hardware / system identifiers are numbers
      S5TIME: 'WORD', HW_ANY: 'WORD', HW_IO: 'WORD', HW_DEVICE: 'WORD', HW_SUBMODULE: 'WORD', HW_INTERFACE: 'WORD',
      DB_ANY: 'UINT', DB_WWW: 'UINT', DB_DYN: 'UINT', OB_ANY: 'INT', OB_CYCLIC: 'INT', OB_ATT: 'INT', OB_PCYCLE: 'INT',
      EVENT_ANY: 'DWORD', EVENT_ATT: 'DWORD', EVENT_HWINT: 'DWORD', CONN_ANY: 'WORD', CONN_OUC: 'WORD', PORT: 'UINT', RTM: 'UINT', PIP: 'UINT',
    };
    const name = aliases[upper] ?? upper;
    if (name === 'STRING' || name === 'WSTRING') {
      // WString is stored like String (UTF-8, at most 254 bytes)
      let length = name === 'WSTRING' ? 254 : 32;
      if (this.accept('[')) {
        length = Number(this.expect('int').value);
        this.expectOp(']');
        if (length < 1 || length > 254) throw this.error('STRING length must be between 1 and 254', id);
      }
      return { name: 'STRING', length, line: id.line };
    }
    // Elementary types are normalised to upper case; FB type names keep their spelling.
    return { name: ELEMENTARY_NAMES.has(name) || name === 'VOID' ? name : (aliases[upper] ?? id.text), line: id.line };
  }

  private signedInt(): number {
    const neg = this.accept('-');
    const v = Number(this.expect('int').value);
    return neg ? -v : v;
  }

  // ------------------------------------------------------------ statements

  private statements(terminators: string[]): Stmt[] {
    const out: Stmt[] = [];
    for (;;) {
      const t = this.cur();
      if (t.type === 'keyword' && terminators.includes(t.text)) return out;
      if (t.type === 'eof') throw this.unexpected(terminators.map((x) => `'${x}'`).join(' or '));
      if (this.accept(';')) continue;
      if (this.isKeyword('REGION')) {
        this.skipLine(t.line);
        continue;
      }
      if (this.acceptKeyword('END_REGION')) {
        this.accept(';');
        continue;
      }
      out.push(this.statement());
    }
  }

  private statement(): Stmt {
    const t = this.cur();
    if (t.type === 'ident' || t.type === 'address') return this.assignmentOrCall();
    if (t.type !== 'keyword') throw this.unexpected('a statement');
    switch (t.text) {
      case 'IF':
        return this.ifStatement();
      case 'WHILE': {
        this.next();
        const cond = this.expression();
        this.expectKeyword('DO');
        const body = this.statements(['END_WHILE']);
        this.close('END_WHILE');
        return { kind: 'while', cond, body, line: t.line };
      }
      case 'REPEAT': {
        this.next();
        const body = this.statements(['UNTIL']);
        this.expectKeyword('UNTIL');
        const until = this.expression();
        this.close('END_REPEAT');
        return { kind: 'repeat', body, until, line: t.line };
      }
      case 'FOR': {
        this.next();
        const v = this.expectIdent();
        this.expectOp(':=');
        const start = this.expression();
        this.expectKeyword('TO');
        const end = this.expression();
        const step = this.acceptKeyword('BY') ? this.expression() : null;
        this.expectKeyword('DO');
        const body = this.statements(['END_FOR']);
        this.close('END_FOR');
        return { kind: 'for', variable: v.text, scope: v.scope ?? null, start, end, step, body, line: t.line };
      }
      case 'CASE':
        return this.caseStatement();
      case 'EXIT':
      case 'CONTINUE':
      case 'RETURN':
        this.next();
        this.expectOp(';');
        return { kind: t.text === 'EXIT' ? 'exit' : t.text === 'CONTINUE' ? 'continue' : 'return', line: t.line };
      default:
        throw this.unexpected('a statement');
    }
  }

  private assignmentOrCall(): Stmt {
    const t = this.cur();
    const target = this.postfix(this.atom());
    const op = this.cur();
    if (op.type === 'op' && (op.text === ':=' || op.text in COMPOUND)) {
      if (target.kind === 'call') throw this.unexpected("';'");
      this.next();
      const value = this.expression();
      this.expectOp(';');
      return { kind: 'assign', target, value, op: COMPOUND[op.text] ?? null, line: t.line };
    }
    if (target.kind === 'call') {
      this.expectOp(';');
      return { kind: 'call', call: target, line: t.line };
    }
    throw this.unexpected(`':=' or '('${t.type === 'ident' ? ` after '${t.text}'` : ''}`);
  }

  private ifStatement(): Stmt {
    const start = this.next();
    const stops = ['ELSIF', 'ELSE', 'END_IF'];
    const branches: Array<{ cond: Expr; body: Stmt[] }> = [];
    let cond = this.expression();
    this.expectKeyword('THEN');
    branches.push({ cond, body: this.statements(stops) });
    for (;;) {
      if (this.acceptKeyword('ELSIF')) {
        // standard form
      } else if (this.isKeyword('ELSE') && this.peek(1).text === 'IF' && this.peek(1).type === 'keyword' && this.peek(1).line === this.cur().line) {
        // "ELSE IF" on one line is an alias of ELSIF (single END_IF)
        this.next();
        this.next();
      } else {
        break;
      }
      cond = this.expression();
      this.expectKeyword('THEN');
      branches.push({ cond, body: this.statements(stops) });
    }
    const els = this.acceptKeyword('ELSE') ? this.statements(['END_IF']) : null;
    this.close('END_IF');
    return { kind: 'if', branches, else: els, line: start.line };
  }

  private caseStatement(): Stmt {
    const start = this.next();
    const selector = this.expression();
    this.expectKeyword('OF');
    const branches: Array<{ ranges: Array<[number, number]>; body: Stmt[] }> = [];
    let els: Stmt[] | null = null;
    while (!this.isKeyword('END_CASE')) {
      if (this.acceptKeyword('ELSE')) {
        els = this.statements(['END_CASE']);
        break;
      }
      const ranges: Array<[number, number]> = [];
      do {
        const low = this.signedInt();
        const high = this.accept('..') ? this.signedInt() : low;
        if (high < low) throw this.error(`Invalid CASE range ${low}..${high}`, this.cur());
        ranges.push([low, high]);
      } while (this.accept(','));
      this.expectOp(':');
      branches.push({ ranges, body: this.caseBody() });
    }
    this.close('END_CASE');
    if (branches.length === 0 && els === null) throw this.error('CASE statement without any branch', start);
    return { kind: 'case', selector, branches, else: els, line: start.line };
  }

  private caseBody(): Stmt[] {
    const body: Stmt[] = [];
    for (;;) {
      const t = this.cur();
      const isLabel = t.type === 'int' || (t.text === '-' && t.type === 'op' && this.peek(1).type === 'int');
      if (isLabel || this.isKeyword('ELSE') || this.isKeyword('END_CASE')) return body;
      if (t.type === 'eof') throw this.unexpected("'END_CASE'");
      if (this.accept(';')) continue;
      if (this.isKeyword('REGION')) {
        this.skipLine(t.line);
        continue;
      }
      if (this.acceptKeyword('END_REGION')) {
        this.accept(';');
        continue;
      }
      body.push(this.statement());
    }
  }

  private close(keyword: string): void {
    this.expectKeyword(keyword);
    this.accept(';');
  }

  private args(): CallArg[] {
    this.expectOp('(');
    const args: CallArg[] = [];
    if (!this.isOp(')')) {
      do {
        const n = this.peek(1);
        if (this.cur().type === 'ident' && n.type === 'op' && (n.text === ':=' || n.text === '=>')) {
          const name = this.next().text;
          const output = this.next().text === '=>';
          args.push({ name, value: this.expression(), output });
        } else {
          args.push({ name: null, value: this.expression(), output: false });
        }
      } while (this.accept(','));
    }
    this.expectOp(')');
    return args;
  }

  // ----------------------------------------------------------- expressions

  private expression(): Expr {
    return this.binary(0);
  }

  private binary(level: number): Expr {
    if (level >= PRECEDENCE.length) return this.unary();
    let left = this.binary(level + 1);
    while ((this.cur().type === 'op' || this.cur().type === 'keyword') && PRECEDENCE[level].includes(this.cur().text)) {
      const op = this.next();
      const right = this.binary(level + 1);
      left = { kind: 'binary', op: op.text, left, right, line: op.line };
    }
    return left;
  }

  private unary(): Expr {
    const t = this.cur();
    if (this.isKeyword('NOT') || this.isOp('-') || this.isOp('+')) {
      this.next();
      const operand = this.unary();
      if (t.text === '+') return operand;
      if (t.text === '-' && (operand.kind === 'int' || operand.kind === 'real' || operand.kind === 'time')) {
        return { ...operand, value: -operand.value } as Expr;
      }
      return { kind: 'unary', op: t.text === 'NOT' ? 'NOT' : '-', operand, line: t.line };
    }
    return this.postfix(this.primary());
  }

  private primary(): Expr {
    const t = this.cur();
    switch (t.type) {
      case 'int':
        this.next();
        return { kind: 'int', value: t.value as number, line: t.line };
      case 'real':
        this.next();
        return { kind: 'real', value: t.value as number, line: t.line };
      case 'bool':
        this.next();
        return { kind: 'bool', value: t.value as boolean, line: t.line };
      case 'string':
        this.next();
        return { kind: 'string', value: t.value as string, line: t.line };
      case 'time':
        this.next();
        return { kind: 'time', value: t.value as number, line: t.line };
      case 'typed':
        this.next();
        return { kind: 'typed', type: t.text, value: t.value as bigint, line: t.line };
      case 'ident':
      case 'address':
        return this.atom();
      default:
        if (this.accept('(')) {
          const e = this.expression();
          this.expectOp(')');
          return e;
        }
        throw this.unexpected('an expression');
    }
  }

  private atom(): Expr {
    const t = this.next();
    if (t.type === 'address') {
      const address = parseAddress(t.text);
      if (!address) throw this.error(`Invalid address %${t.text}`, t);
      return { kind: 'addr', address, line: t.line };
    }
    if (t.type !== 'ident') {
      this.i--;
      throw this.unexpected('an identifier');
    }
    return { kind: 'var', name: t.text, scope: t.scope ?? null, line: t.line };
  }

  private postfix(expr: Expr): Expr {
    for (;;) {
      if (this.isOp('.')) {
        this.next();
        const m = this.expectIdent();
        expr = { kind: 'member', base: expr, member: m.text, line: m.line };
      } else if (this.isOp('[')) {
        const t = this.next();
        const index = this.expression();
        this.expectOp(']');
        expr = { kind: 'index', base: expr, index, line: t.line };
      } else if (this.isOp('(') && expr.kind !== 'call' && expr.kind !== 'addr') {
        expr = { kind: 'call', callee: expr, args: this.args(), line: expr.line };
      } else {
        return expr;
      }
    }
  }

  // ---------------------------------------------------------------- tokens

  private cur(): Token {
    return this.tokens[this.i];
  }

  private peek(o: number): Token {
    return this.tokens[Math.min(this.i + o, this.tokens.length - 1)];
  }

  private next(): Token {
    const t = this.cur();
    if (t.type !== 'eof') this.i++;
    return t;
  }

  private at(type: Token['type']): boolean {
    return this.cur().type === type;
  }

  private isOp(text: string): boolean {
    return this.cur().type === 'op' && this.cur().text === text;
  }

  private isKeyword(text: string): boolean {
    return this.cur().type === 'keyword' && this.cur().text === text;
  }

  private accept(op: string): boolean {
    if (this.isOp(op)) {
      this.next();
      return true;
    }
    return false;
  }

  private acceptKeyword(kw: string): boolean {
    if (this.isKeyword(kw)) {
      this.next();
      return true;
    }
    return false;
  }

  private expect(type: Token['type']): Token {
    if (!this.at(type)) {
      const what = { int: 'an integer', address: 'an address', ident: 'an identifier' } as Record<string, string>;
      throw this.unexpected(what[type] ?? type);
    }
    return this.next();
  }

  private expectIdent(): Token {
    return this.expect('ident');
  }

  private expectOp(op: string): void {
    if (!this.accept(op)) throw this.unexpected(`'${op}'`);
  }

  private expectKeyword(kw: string): void {
    if (!this.acceptKeyword(kw)) throw this.unexpected(`'${kw}'`);
  }

  private unexpected(expected: string): CompileError {
    const t = this.cur();
    return new CompileError(`Expected ${expected}, found ${describeToken(t)}`, t.line, t.column, this.file);
  }

  private error(message: string, t: Token): CompileError {
    return new CompileError(message, t.line, t.column, this.file);
  }
}

export const ELEMENTARY_NAMES = new Set([
  'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD', 'SINT', 'USINT', 'INT', 'UINT', 'DINT', 'UDINT', 'LINT', 'ULINT', 'REAL', 'LREAL',
  'TIME', 'LTIME', 'DATE', 'TOD', 'LTOD', 'DT', 'LDT', 'CHAR', 'WCHAR', 'STRING',
]);
