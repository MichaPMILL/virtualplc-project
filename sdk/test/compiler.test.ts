import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile, compileSource, readImage, Section, findSymbol } from '../src/index.ts';

const root = new URL('../../', import.meta.url);

function errors(source: string): string[] {
  const r = compileSource(source);
  return r.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.line ?? '?'}: ${d.message}`);
}

function expectError(source: string, fragment: string): void {
  const errs = errors(source);
  assert.ok(errs.some((e) => e.includes(fragment)), `expected an error containing "${fragment}", got:\n${errs.join('\n') || '(none)'}`);
}

test('compiles the external source example into a valid image', () => {
  const r = compileSource(readFileSync(new URL('examples/scl/motor.scl', root), 'utf8'), 'motor.scl', { buildTime: 0 });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const img = readImage(r.image!);
  for (const s of [Section.META, Section.LIMITS, Section.CODE, Section.FUNCS, Section.ENTRIES, Section.INIT]) {
    assert.ok(img.sections.has(s), `section ${s}`);
  }
  assert.match(r.programId!, /^[0-9a-f]{8}$/);
  assert.deepEqual(r.functions.map((f) => f.name), ['Motor', 'Main', 'Startup']);
  const running = findSymbol(r.symbols, '"Motor_DB".Running');
  assert.equal(running?.type, 'Bool');
  assert.equal(findSymbol(r.symbols, 'Start_Button')?.area, 'I');
});

test('builds are reproducible', () => {
  const src = 'VAR_GLOBAL a : Int; END_VAR ORGANIZATION_BLOCK "Main" BEGIN a := a + 1; END_ORGANIZATION_BLOCK';
  assert.equal(compileSource(src, 'a', { buildTime: 1 }).programId, compileSource(src, 'a', { buildTime: 1 }).programId);
});

test('compiles historical VirtualPLC sections (VAR, DB, BLOCK, FC)', () => {
  const r = compileSource(`
    VAR SystemOn : BOOL; Counter : INT; END_VAR
    DB SystemOn := TRUE; END_DB
    BLOCK Count
      IF SystemOn THEN Counter := Counter + 1; END_IF;
    END_BLOCK
    FC Count(); END_FC`);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.deepEqual(r.functions.map((f) => f.name), ['Count', 'Main', 'Startup']);
});

test('reports errors with block file and line', () => {
  const r = compile({
    sources: [
      { file: 'tags.scl', text: 'VAR_GLOBAL x : Int; END_VAR' },
      { file: 'Main.scl', text: 'ORGANIZATION_BLOCK "Main"\nBEGIN\n  x := y;\nEND_ORGANIZATION_BLOCK' },
    ],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.diagnostics.map((d) => [d.file, d.line, d.message]),
    [['Main.scl', 3, "Undeclared variable 'y'"]],
  );
});

test('reports several errors at once', () => {
  const errs = errors('ORGANIZATION_BLOCK "Main" BEGIN\n a := 1;\n b := 2;\nEND_ORGANIZATION_BLOCK');
  assert.equal(errs.length, 2);
});

const cases: Array<[string, string, string]> = [
  ['syntax', 'ORGANIZATION_BLOCK "Main" BEGIN x := 1 END_ORGANIZATION_BLOCK', "Expected ';'"],
  ['unknown local', 'FUNCTION_BLOCK "F" BEGIN #nope := 1; END_FUNCTION_BLOCK', "in the interface of 'F'"],
  ['unknown global', 'ORGANIZATION_BLOCK "Main" BEGIN "Nope" := 1; END_ORGANIZATION_BLOCK', 'in the PLC tags or data blocks'],
  ['write %I', 'ORGANIZATION_BLOCK "Main" BEGIN %I0.0 := TRUE; END_ORGANIZATION_BLOCK', 'Cannot assign to input %I0.0'],
  ['write input tag', 'VAR_GLOBAL b AT %I0.0 : Bool; END_VAR ORGANIZATION_BLOCK "Main" BEGIN b := TRUE; END_ORGANIZATION_BLOCK', "Cannot assign to input 'b'"],
  ['address type', 'VAR_GLOBAL b AT %MW0 : Bool; END_VAR', 'does not fit address %MW0'],
  ['unknown type', 'VAR_GLOBAL b : Motor; END_VAR', "Unknown data type 'Motor'"],
  ['FB called directly', 'FUNCTION_BLOCK "F" END_FUNCTION_BLOCK ORGANIZATION_BLOCK "Main" BEGIN "F"(); END_ORGANIZATION_BLOCK', 'must be called through an instance'],
  ['timer called directly', 'ORGANIZATION_BLOCK "Main" BEGIN TON(IN := TRUE, PT := T#1s); END_ORGANIZATION_BLOCK', 'must be called through an instance'],
  ['unknown FB parameter', 'VAR_GLOBAL t : TON; END_VAR ORGANIZATION_BLOCK "Main" BEGIN t(IN := TRUE, PX := T#1s); END_ORGANIZATION_BLOCK', "'TON' has no parameter 'PX'"],
  ['input with =>', 'VAR_GLOBAL t : TON; b : Bool; END_VAR ORGANIZATION_BLOCK "Main" BEGIN t(IN => b); END_ORGANIZATION_BLOCK', "use ':=' instead of '=>'"],
  ['output with :=', 'VAR_GLOBAL t : TON; b : Bool; END_VAR ORGANIZATION_BLOCK "Main" BEGIN t(Q := b); END_ORGANIZATION_BLOCK', "use '=>' instead of ':='"],
  ['unknown member', 'VAR_GLOBAL t : TON; b : Bool; END_VAR ORGANIZATION_BLOCK "Main" BEGIN b := t.Done; END_ORGANIZATION_BLOCK', "'TON' has no member 'Done'"],
  ['constant write', 'FUNCTION "F" : Void VAR CONSTANT K : Int := 1; END_VAR BEGIN #K := 2; END_FUNCTION', 'Cannot assign to a constant'],
  ['instance DB of FC', 'FUNCTION "F" : Void BEGIN END_FUNCTION DATA_BLOCK "D" "F" BEGIN END_DATA_BLOCK', 'not a data type'],
  ['FB instance in FC', 'FUNCTION "F" : Void VAR t : TON; END_VAR BEGIN END_FUNCTION', 'must be declared in a FUNCTION_BLOCK'],
  ['REAL to INT', 'VAR_GLOBAL i : Int; r : Real; END_VAR ORGANIZATION_BLOCK "Main" BEGIN i := r; END_ORGANIZATION_BLOCK', 'use REAL_TO_INT()'],
  ['INT to BOOL', 'VAR_GLOBAL b : Bool; END_VAR ORGANIZATION_BLOCK "Main" BEGIN b := 1; END_ORGANIZATION_BLOCK', 'Cannot use a number as Bool'],
  ['non-bool condition', 'VAR_GLOBAL i : Int; END_VAR ORGANIZATION_BLOCK "Main" BEGIN IF i THEN i := 0; END_IF; END_ORGANIZATION_BLOCK', 'Condition must be of type Bool'],
  ['recursion', 'FUNCTION "A" : Void BEGIN "B"(); END_FUNCTION FUNCTION "B" : Void BEGIN "A"(); END_FUNCTION', 'Recursive calls are not allowed'],
  ['FB contains itself', 'FUNCTION_BLOCK "F" VAR me : "F"; END_VAR BEGIN END_FUNCTION_BLOCK DATA_BLOCK "D" "F" BEGIN END_DATA_BLOCK', 'contains an instance of itself'],
  ['missing FC parameter', 'FUNCTION "F" : Int VAR_INPUT a : Int; END_VAR BEGIN #F := #a; END_FUNCTION VAR_GLOBAL x : Int; END_VAR ORGANIZATION_BLOCK "Main" BEGIN x := "F"(); END_ORGANIZATION_BLOCK', "Missing parameter 'a'"],
  ['array bounds', 'VAR_GLOBAL a : Array[0..2] of Int; END_VAR ORGANIZATION_BLOCK "Main" BEGIN a[3] := 1; END_ORGANIZATION_BLOCK', 'Array index 3 out of bounds [0..2]'],
  ['exit outside loop', 'ORGANIZATION_BLOCK "Main" BEGIN EXIT; END_ORGANIZATION_BLOCK', 'EXIT used outside of a loop'],
  ['bad time literal', 'ORGANIZATION_BLOCK "Main" BEGIN "t" := T#5x; END_ORGANIZATION_BLOCK', "Invalid time literal 'T#5x'"],
  ['legacy binding', 'VAR x : Dev.INPUT.0; END_VAR', "use 'Name AT %I0.0 : Bool;'"],
  ['HARDWARE section', "HARDWARE Io := CONNECT('1.2.3.4', 502, 1); END_HARDWARE", 'declare I/O modules in the device configuration'],
  ['WAIT outside OB', 'FUNCTION "F" : Void BEGIN WAIT(10); END_FUNCTION', 'WAIT can only be used in an organization block'],
  ['duplicate block', 'FUNCTION "F" : Void BEGIN END_FUNCTION FUNCTION "f" : Void BEGIN END_FUNCTION', "Duplicate block 'f'"],
  ['block named like builtin', 'FUNCTION "LIMIT" : Void BEGIN END_FUNCTION', 'name of a built-in instruction'],
];
for (const [name, source, message] of cases) {
  test(`error: ${name}`, () => expectError(source, message));
}

test('warns when there is no Main OB', () => {
  const r = compileSource('VAR_GLOBAL x : Int; END_VAR');
  assert.equal(r.ok, true);
  assert.match(r.diagnostics[0].message, /No cyclic organization block/);
});

test('date and time types are type-safe (explicit conversions)', async () => {
  const { compileSource } = await import('../src/index.ts');
  const err = (body: string, decl = '') => {
    const r = compileSource(`VAR_GLOBAL d : Date; t : TOD; n : DInt; l : LDT; c : Char; stamp : DT; ${decl} END_VAR ORGANIZATION_BLOCK "Main" BEGIN ${body} END_ORGANIZATION_BLOCK`);
    return r.ok ? '' : r.diagnostics.map((x) => x.message).join('; ');
  };
  assert.match(err('d := n;'), /Cannot convert DInt to Date \(use DINT_TO_DATE\(\)\)/);
  assert.match(err('n := d;'), /Cannot convert Date to DInt/);
  assert.match(err('n := d + 1;'), /Operator \+ cannot be applied to Date/);
  assert.match(err('t := t * 2;'), /Operator \* cannot be applied/);
  assert.match(err('stamp := stamp + T#1S;'), /Operator \+ cannot be applied/);
  assert.match(err("c := 'ab';"), /not a single character/);
  assert.match(err('l := T#1S;'), /Cannot use a Time value as LDT|Cannot convert/);
  assert.equal(err('d := DINT_TO_DATE(n); n := DATE_TO_DINT(d); t := t + T#1H; l := l + LT#1S; c := \'x\';'), '');
  assert.match(compileSource('VAR_GLOBAL d : Date := D#2023-02-30; END_VAR').diagnostics[0]?.message ?? '', /Invalid D# literal/);
});

test('monitoring formats dates, times and characters like the PLC literals', async () => {
  const { formatValue, parseTemporal } = await import('../src/index.ts');
  const f = (kind: string, v: number | bigint, size = 8) => formatValue({ name: 'x', type: '', kind: kind as never, area: 'M', offset: 0, size }, v);
  assert.equal(f('date', Number(parseTemporal('DATE', '2024-02-29'))), 'D#2024-02-29');
  assert.equal(f('tod', Number(parseTemporal('TOD', '23:59:59.5'))), 'TOD#23:59:59.500');
  assert.equal(f('ltime', parseTemporal('LTIME', '1d2h3m4s5ms6us7ns')!), 'LT#1D_2H_3M_4S_5MS_6US_7NS');
  assert.equal(f('ldt', parseTemporal('LDT', '2024-01-15-08:00:00.5')!), 'LDT#2024-01-15-08:00:00.500000000');
  assert.equal(f('dt', parseTemporal('DT', '2024-01-15-08:00:00.5')!), 'DT#2024-01-15-08:00:00.500');
  assert.equal(f('char', 65, 1), "'A'");
  assert.equal(f('char', 10, 1), 'CHAR#10');
});
