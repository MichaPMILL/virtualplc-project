/** A compile error with its source position. */
export class CompileError extends Error {
  readonly line: number;
  readonly column: number | undefined;
  file: string | undefined;

  constructor(message: string, line = 0, column?: number, file?: string) {
    super(message);
    this.name = 'CompileError';
    this.line = line;
    this.column = column;
    this.file = file;
  }

  /** "file:line:column: message" */
  format(): string {
    const where = [this.file, this.line || undefined, this.column].filter((x) => x !== undefined).join(':');
    return where ? `${where}: ${this.message}` : this.message;
  }
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export function toDiagnostic(e: unknown, severity: 'error' | 'warning' = 'error'): Diagnostic {
  if (e instanceof CompileError) {
    return { severity, message: e.message, file: e.file, line: e.line || undefined, column: e.column };
  }
  return { severity, message: e instanceof Error ? e.message : String(e) };
}
