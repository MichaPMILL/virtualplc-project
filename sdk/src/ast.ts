// Abstract syntax tree produced by the parser.

export type Scope = 'global' | 'local' | null;

export interface TypeRef {
  /** Upper-case for elementary types (INT, REAL, ...), as written for FB types. */
  name: string;
  element?: TypeRef;
  low?: number;
  high?: number;
  /** STRING[n] */
  length?: number;
  /** Anonymous STRUCT ... END_STRUCT */
  fields?: VarDecl[];
  line: number;
}

export interface Address {
  area: 'I' | 'Q' | 'M';
  size: 'X' | 'B' | 'W' | 'D';
  byte: number;
  bit: number;
}

export type Expr =
  | { kind: 'int'; value: number; line: number; typed?: string }
  | { kind: 'real'; value: number; line: number }
  | { kind: 'bool'; value: boolean; line: number }
  | { kind: 'string'; value: string; line: number }
  | { kind: 'time'; value: number; line: number }
  /** Date / time-of-day / LTIME / character literal (value in the representation of the type) */
  | { kind: 'typed'; type: string; value: bigint; line: number }
  | { kind: 'var'; name: string; scope: Scope; line: number }
  | { kind: 'addr'; address: Address; line: number }
  | { kind: 'member'; base: Expr; member: string; line: number }
  | { kind: 'index'; base: Expr; index: Expr; line: number }
  | { kind: 'call'; callee: Expr; args: CallArg[]; line: number }
  | { kind: 'binary'; op: string; left: Expr; right: Expr; line: number }
  | { kind: 'unary'; op: 'NOT' | '-'; operand: Expr; line: number };

export interface CallArg {
  name: string | null;
  value: Expr;
  output: boolean;
}

export type Stmt =
  | { kind: 'assign'; target: Expr; value: Expr; op: string | null; line: number }
  | { kind: 'call'; call: Extract<Expr, { kind: 'call' }>; line: number }
  | { kind: 'if'; branches: Array<{ cond: Expr; body: Stmt[] }>; else: Stmt[] | null; line: number }
  | { kind: 'while'; cond: Expr; body: Stmt[]; line: number }
  | { kind: 'repeat'; body: Stmt[]; until: Expr; line: number }
  | { kind: 'for'; variable: string; scope: Scope; start: Expr; end: Expr; step: Expr | null; body: Stmt[]; line: number }
  | { kind: 'case'; selector: Expr; branches: Array<{ ranges: Array<[number, number]>; body: Stmt[] }>; else: Stmt[] | null; line: number }
  | { kind: 'exit'; line: number }
  | { kind: 'continue'; line: number }
  | { kind: 'return'; line: number };

export type Section = 'global' | 'input' | 'output' | 'inout' | 'static' | 'temp' | 'constant';

export interface VarDecl {
  name: string;
  type: TypeRef;
  initial: Expr | null;
  address: Address | null;
  section: Section;
  line: number;
  file?: string;
}

export type PouKind = 'FUNCTION' | 'FUNCTION_BLOCK' | 'ORGANIZATION_BLOCK';

export interface Pou {
  kind: PouKind;
  name: string;
  returnType: TypeRef | null;
  vars: VarDecl[];
  body: Stmt[];
  line: number;
  file?: string;
  /** Object orientation (IEC 61131-3 ed.3, function blocks only) */
  extends?: string;
  implements?: string[];
  methods?: Method[];
  abstract?: boolean;
  final?: boolean;
  /** CLASS ... END_CLASS: a function block without body nor inputs/outputs */
  isClass?: boolean;
  /** Source range of the statements (import of external sources) */
  bodyRange?: TextRange;
}

/** 1-based lines and columns; `to` is exclusive */
export interface TextRange {
  fromLine: number;
  fromCol: number;
  toLine: number;
  toCol: number;
}

export type Access = 'PUBLIC' | 'PRIVATE' | 'PROTECTED' | 'INTERNAL';

/** METHOD of a function block, a class or an interface (prototype) */
export interface Method {
  name: string;
  returnType: TypeRef | null;
  vars: VarDecl[];
  body: Stmt[];
  access: Access;
  /** access specifier written in the source (an override keeps the access of the overridden method otherwise) */
  accessGiven?: boolean;
  abstract: boolean;
  final: boolean;
  override: boolean;
  line: number;
  file?: string;
  bodyRange?: TextRange;
}

/** INTERFACE "Name" [EXTENDS ...] METHOD ... END_METHOD ... END_INTERFACE */
export interface InterfaceDecl {
  name: string;
  extends: string[];
  methods: Method[];
  line: number;
  file?: string;
}

export interface DataBlock {
  name: string;
  instanceOf: string | null;
  fields: VarDecl[];
  init: Stmt[];
  line: number;
  file?: string;
}

/** PLC data type (UDT): TYPE "Name" STRUCT ... END_STRUCT END_TYPE */
export interface UserType {
  name: string;
  fields: VarDecl[];
  line: number;
  file?: string;
}

export interface Program {
  vars: VarDecl[];
  pous: Pou[];
  dataBlocks: DataBlock[];
  types: UserType[];
  interfaces: InterfaceDecl[];
}
