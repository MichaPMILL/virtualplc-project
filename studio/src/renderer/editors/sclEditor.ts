// SCL code editor (CodeMirror 6) with syntax colours, completion, errors and online values.
import { autocompletion, type Completion, type CompletionContext, snippetCompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, indentOnInput, indentUnit, StreamLanguage, syntaxHighlighting, bracketMatching } from '@codemirror/language';
import { linter, lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration, type DecorationSet, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, WidgetType,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';

const KEYWORDS = new Set([
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF', 'CASE', 'OF', 'END_CASE', 'FOR', 'TO', 'BY', 'DO', 'END_FOR', 'WHILE', 'END_WHILE',
  'REPEAT', 'UNTIL', 'END_REPEAT', 'EXIT', 'CONTINUE', 'RETURN', 'REGION', 'END_REGION', 'AND', 'OR', 'XOR', 'NOT', 'MOD',
  'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_TEMP', 'VAR_GLOBAL', 'END_VAR', 'CONSTANT', 'BEGIN',
  'FUNCTION', 'END_FUNCTION', 'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK', 'ORGANIZATION_BLOCK', 'END_ORGANIZATION_BLOCK',
  'DATA_BLOCK', 'END_DATA_BLOCK', 'ARRAY', 'AT',
]);
const TYPES = new Set(['BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD', 'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'REAL', 'LREAL',
  'TIME', 'LTIME', 'DATE', 'TOD', 'TIME_OF_DAY', 'LTOD', 'LTIME_OF_DAY', 'DT', 'DATE_AND_TIME', 'LDT', 'DTL', 'CHAR', 'WCHAR', 'STRING', 'WSTRING', 'VOID']);

interface SclState { comment: 0 | 1 | 2 }

/** Tokenizer for SCL. */
const scl = StreamLanguage.define<SclState>({
  name: 'scl',
  startState: () => ({ comment: 0 }),
  token(stream, state) {
    if (state.comment) {
      const end = state.comment === 1 ? '*)' : '*/';
      if (stream.skipTo(end)) {
        stream.pos += 2;
        state.comment = 0;
      } else {
        stream.skipToEnd();
      }
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('(*')) {
      state.comment = 1;
      return 'comment';
    }
    if (stream.match('/*')) {
      state.comment = 2;
      return 'comment';
    }
    if (stream.match(/^'([^'$]|\$.)*'?/)) return 'string';
    if (stream.match(/^"[^"\n]*"?/)) return 'variableName.special';
    if (stream.match(/^#[A-Za-z_]\w*/)) return 'variableName.local';
    if (stream.match(/^%[IQM][XBWD]?\d+(\.\d)?/i)) return 'atom';
    if (stream.match(/^(T|TIME|LT|LTIME|D|DATE|TOD|TIME_OF_DAY|LTOD|LTIME_OF_DAY|DT|DATE_AND_TIME|LDT|DTL)#[-\w.:]+/i)) return 'number';
    if (stream.match(/^(W?CHAR|W?STRING)#/i)) return 'number';
    if (stream.match(/^\d+#[0-9A-Fa-f_]+/) || stream.match(/^\d[\d_]*(\.\d+)?([eE][-+]?\d+)?/)) return 'number';
    if (stream.match(/^[A-Za-z_]\w*/)) {
      const w = stream.current().toUpperCase();
      if (w === 'TRUE' || w === 'FALSE') return 'bool';
      if (KEYWORDS.has(w)) return 'keyword';
      if (TYPES.has(w)) return 'typeName';
      if (stream.match(/^\s*\(/, false)) return 'function';
      return 'variableName';
    }
    if (stream.match(/^(:=|=>|<>|<=|>=|\*\*|[-+*/=<>&])/)) return 'operator';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '//', block: { open: '(*', close: '*)' } } },
});

const tiaColours = HighlightStyle.define([
  { tag: tags.keyword, color: '#1f4fb3', fontWeight: '600' },
  { tag: tags.typeName, color: '#7a3e9d' },
  { tag: tags.comment, color: '#3a8a3a', fontStyle: 'italic' },
  { tag: tags.string, color: '#a31515' },
  { tag: tags.number, color: '#098658' },
  { tag: tags.bool, color: '#1f4fb3', fontWeight: '600' },
  { tag: tags.special(tags.variableName), color: '#7f4a00' },
  { tag: tags.local(tags.variableName), color: '#00508a' },
  { tag: tags.atom, color: '#b55a00' },
  { tag: tags.function(tags.variableName), color: '#008080' },
  { tag: tags.operator, color: '#444' },
]);

// ---------------------------------------------------------------------------
// Online values at the end of lines
// ---------------------------------------------------------------------------

export interface LineValues {
  line: number;
  items: Array<{ label: string; text: string }>;
}

class MonitorWidget extends WidgetType {
  constructor(private readonly items: LineValues['items']) {
    super();
  }

  eq(other: MonitorWidget): boolean {
    return JSON.stringify(other.items) === JSON.stringify(this.items);
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-monitor';
    this.items.forEach((it, i) => {
      if (i) span.append('   ');
      const b = document.createElement('b');
      b.textContent = `${it.label} `;
      const v = document.createElement('span');
      v.textContent = it.text;
      if (it.text === 'TRUE') v.className = 'true';
      if (it.text === 'FALSE') v.className = 'false';
      span.append(b, v);
    });
    return span;
  }
}

const setMonitorEffect = StateEffect.define<LineValues[]>();
const monitorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setMonitorEffect)) {
        const builder = new RangeSetBuilder<Decoration>();
        for (const lv of [...e.value].sort((a, b) => a.line - b.line)) {
          if (lv.line < 1 || lv.line > tr.state.doc.lines || lv.items.length === 0) continue;
          const line = tr.state.doc.line(lv.line);
          builder.add(line.to, line.to, Decoration.widget({ widget: new MonitorWidget(lv.items), side: 1 }));
        }
        return builder.finish();
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------------------

export interface CompletionSource {
  globals(): Array<{ name: string; type: string }>;
  locals(): Array<{ name: string; type: string }>;
  members(path: string): Array<{ name: string; type: string }>;
}

const INSTRUCTIONS: Completion[] = [
  snippetCompletion('IF ${condition} THEN\n\t${}\nEND_IF;', { label: 'IF...THEN', type: 'keyword', detail: 'Exécuter si' }),
  snippetCompletion('IF ${condition} THEN\n\t${}\nELSE\n\t\nEND_IF;', { label: 'IF...THEN...ELSE', type: 'keyword', detail: 'Branchement' }),
  snippetCompletion('CASE ${selector} OF\n\t1:\n\t\t${}\nELSE\n\t\nEND_CASE;', { label: 'CASE...OF', type: 'keyword', detail: 'Sélection multiple' }),
  snippetCompletion('FOR #${i} := ${0} TO ${10} DO\n\t${}\nEND_FOR;', { label: 'FOR...TO...DO', type: 'keyword', detail: 'Boucle comptée' }),
  snippetCompletion('WHILE ${condition} DO\n\t${}\nEND_WHILE;', { label: 'WHILE...DO', type: 'keyword', detail: 'Boucle conditionnelle' }),
  snippetCompletion('REPEAT\n\t${}\nUNTIL ${condition}\nEND_REPEAT;', { label: 'REPEAT...UNTIL', type: 'keyword', detail: 'Boucle' }),
  snippetCompletion('REGION ${name}\n\t${}\nEND_REGION', { label: 'REGION', type: 'keyword', detail: 'Structurer le code' }),
  ...['ABS', 'SQRT', 'SQR', 'EXP', 'LN', 'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'TRUNC', 'ROUND', 'CEIL', 'FLOOR', 'FRAC', 'LEN']
    .map((f) => snippetCompletion(`${f}(\${})`, { label: f, type: 'function', detail: 'Mathématiques' })),
  snippetCompletion('MIN(IN1 := ${}, IN2 := )', { label: 'MIN', type: 'function', detail: 'Minimum' }),
  snippetCompletion('MAX(IN1 := ${}, IN2 := )', { label: 'MAX', type: 'function', detail: 'Maximum' }),
  snippetCompletion('LIMIT(MN := ${}, IN := , MX := )', { label: 'LIMIT', type: 'function', detail: 'Limiter' }),
  snippetCompletion('SEL(G := ${}, IN0 := , IN1 := )', { label: 'SEL', type: 'function', detail: 'Sélectionner' }),
  snippetCompletion('NORM_X(MIN := ${}, VALUE := , MAX := )', { label: 'NORM_X', type: 'function', detail: 'Normaliser' }),
  snippetCompletion('SCALE_X(MIN := ${}, VALUE := , MAX := )', { label: 'SCALE_X', type: 'function', detail: 'Mettre à l\'échelle' }),
  snippetCompletion('CONCAT(IN1 := ${}, IN2 := )', { label: 'CONCAT', type: 'function', detail: 'Chaîne' }),
  snippetCompletion('LOG(${})', { label: 'LOG', type: 'function', detail: 'Tampon de diagnostic' }),
  snippetCompletion('DEVICE_OK(${})', { label: 'DEVICE_OK', type: 'function', detail: 'Module d\'E/S en échange de données' }),
  snippetCompletion('DEVICE_DIAG(${})', { label: 'DEVICE_DIAG', type: 'function', detail: 'Diagnostic actif sur le module' }),
  snippetCompletion('PN_ALARM(MODULE := ${}, SLOT := 1, KIND := 1, CODE := 1)', { label: 'PN_ALARM', type: 'function', detail: 'Alarme PROFINET vers le maître' }),
];

function completionSource(src: CompletionSource) {
  return (ctx: CompletionContext) => {
    const member = ctx.matchBefore(/("[^"\n]+"|#?[A-Za-z_]\w*)(\.[A-Za-z_]\w*)*\.\w*$/);
    if (member) {
      const dot = member.text.lastIndexOf('.');
      const options = src.members(member.text.slice(0, dot)).map((m) => ({ label: m.name, type: 'property', detail: m.type }));
      if (options.length) return { from: member.from + dot + 1, options, validFor: /^\w*$/ };
    }
    const local = ctx.matchBefore(/#\w*/);
    if (local) return { from: local.from, options: src.locals().map((v) => ({ label: `#${v.name}`, type: 'variable', detail: v.type })), validFor: /^#\w*$/ };
    const quoted = ctx.matchBefore(/"[^"\n]*/);
    if (quoted) return { from: quoted.from, options: src.globals().map((v) => ({ label: `"${v.name}"`, type: 'variable', detail: v.type })) };
    const word = ctx.matchBefore(/[A-Za-z_]\w*/);
    if (!word && !ctx.explicit) return null;
    return {
      from: word?.from ?? ctx.pos,
      options: [
        ...INSTRUCTIONS,
        ...[...KEYWORDS].map((k) => ({ label: k, type: 'keyword' })),
        ...src.globals().map((v) => ({ label: `"${v.name}"`, type: 'variable', detail: v.type, apply: `"${v.name}"` })),
        ...src.locals().map((v) => ({ label: `#${v.name}`, type: 'variable', detail: v.type })),
      ],
      validFor: /^\w*$/,
    };
  };
}

export class SclEditor {
  readonly view: EditorView;
  private diagnostics: Diagnostic[] = [];

  constructor(parent: HTMLElement, doc: string, onChange: (text: string) => void, completions: CompletionSource) {
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          indentUnit.of('    '),
          EditorState.tabSize.of(4),
          scl,
          syntaxHighlighting(tiaColours),
          autocompletion({ override: [completionSource(completions)], activateOnTyping: true }),
          lintGutter(),
          linter(() => this.diagnostics, { delay: 0 }),
          monitorField,
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChange(u.state.doc.toString());
          }),
          EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
        ],
      }),
    });
  }

  setErrors(errors: Array<{ line: number; message: string; severity: 'error' | 'warning' }>): void {
    const doc = this.view.state.doc;
    this.diagnostics = errors.filter((e) => e.line >= 1 && e.line <= doc.lines).map((e) => {
      const line = doc.line(e.line);
      const text = line.text;
      const start = line.from + (text.length - text.trimStart().length);
      return { from: start, to: Math.max(start, line.to), severity: e.severity, message: e.message };
    });
    this.view.dispatch(setDiagnostics(this.view.state, this.diagnostics));
  }

  setMonitor(values: LineValues[]): void {
    this.view.dispatch({ effects: setMonitorEffect.of(values) });
  }

  gotoLine(line: number): void {
    const doc = this.view.state.doc;
    const l = doc.line(Math.max(1, Math.min(doc.lines, line)));
    this.view.dispatch({ selection: { anchor: l.from, head: l.to }, scrollIntoView: true });
    this.view.focus();
  }

  insert(text: string): void {
    const { from, to } = this.view.state.selection.main;
    this.view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    this.view.focus();
  }

  get text(): string {
    return this.view.state.doc.toString();
  }

  setText(text: string): void {
    if (text === this.text) return;
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
  }

  destroy(): void {
    this.view.destroy();
  }
}

/** Operands of a line of code that can be monitored: "Global".x, #local.y, %I0.0 */
export function operandsOf(line: string): string[] {
  const code = line.replace(/\/\/.*$/, '').replace(/\(\*.*?\*\)/g, '').replace(/'([^'$]|\$.)*'/g, "''");
  const out: string[] = [];
  const re = /("[^"\n]+"|#[A-Za-z_]\w*|%[IQM][XBWD]?\d+(?:\.\d)?|\b[A-Za-z_]\w*)((?:\.[A-Za-z_]\w*)*)(\s*\()?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[3]) continue; // call
    const head = m[1];
    if (/^[A-Za-z_]/.test(head) && (KEYWORDS.has(head.toUpperCase()) || TYPES.has(head.toUpperCase()) || /^(TRUE|FALSE|T|TIME)$/i.test(head))) continue;
    const p = head + m[2];
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
