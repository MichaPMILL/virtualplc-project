// Object orientation (IEC 61131-3 edition 3): methods, inheritance, interfaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSource } from '../src/compiler.ts';
import { simAvailable, withSim } from './sim.ts';

const skip = simAvailable ? false : 'build runtime/ first';
const errors = (src: string) => compileSource(src).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

const SHAPES = `
INTERFACE IShape
  METHOD Area : REAL
  END_METHOD
  METHOD Scale
    VAR_INPUT k : REAL; END_VAR
  END_METHOD
END_INTERFACE

INTERFACE INamed
  METHOD Code : INT
  END_METHOD
END_INTERFACE

FUNCTION_BLOCK ABSTRACT Shape IMPLEMENTS IShape, INamed
  VAR scaled : INT; END_VAR
  METHOD PUBLIC ABSTRACT Area : REAL
  END_METHOD
  METHOD Scale
    VAR_INPUT k : REAL; END_VAR
    scaled := scaled + 1;
    THIS.Resize(k := k);
  END_METHOD
  METHOD PROTECTED Resize
    VAR_INPUT k : REAL; END_VAR
  END_METHOD
  METHOD Code : INT
    Code := 1;
  END_METHOD
  METHOD Describe : REAL
    // virtual call through THIS: the implementation of the derived block runs
    Describe := Area() * 10.0;
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK Rect EXTENDS Shape
  VAR_INPUT w : REAL := 2.0; h : REAL := 3.0; END_VAR
  METHOD Area : REAL
    Area := w * h;
  END_METHOD
  METHOD OVERRIDE Resize
    VAR_INPUT k : REAL; END_VAR
    w := w * k;
    h := h * k;
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK Square EXTENDS Rect
  METHOD Code : INT
    Code := SUPER.Code() + 10;
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK Circle EXTENDS Shape
  VAR_INPUT r : REAL := 1.0; END_VAR
  VAR_OUTPUT calls : INT; END_VAR
  METHOD Area : REAL
    Area := 3.0 * r * r;
  END_METHOD
  METHOD Resize
    VAR_INPUT k : REAL; END_VAR
    r := r * k;
  END_METHOD
  calls := calls + 1;
  SUPER();
END_FUNCTION_BLOCK

FUNCTION Total : REAL
  VAR_IN_OUT s : Shape; END_VAR
  Total := s.Area();
END_FUNCTION

VAR_GLOBAL
  r1 : Rect; sq : Square; circ : Circle;
  shapes : ARRAY[1..3] OF IShape;
  named : INamed;
  none : IShape;
  sum : REAL; codes : INT; d1 : REAL; d2 : REAL; t : REAL; isNull : BOOL; same : BOOL;
END_VAR

ORGANIZATION_BLOCK Main
VAR_TEMP i : INT; END_VAR
  shapes[1] := r1;
  shapes[2] := sq;
  shapes[3] := circ;
  sum := 0.0;
  FOR i := 1 TO 3 DO
    sum := sum + shapes[i].Area();
  END_FOR;
  named := sq;
  codes := named.Code();
  named := circ;
  codes := codes * 100 + named.Code();
  d1 := r1.Describe();
  d2 := circ.Describe();
  t := Total(s := sq);
  isNull := none = NULL;
  same := shapes[2] = sq;
  circ();
END_ORGANIZATION_BLOCK

ORGANIZATION_BLOCK Startup
  sq.w := 1.0; sq.h := 1.0;
  shapes[3] := circ;
  shapes[3].Scale(k := 2.0);
END_ORGANIZATION_BLOCK
`;

test('OOP: interfaces, inheritance and virtual methods', { skip }, async () => {
  await withSim(SHAPES, async (sim) => {
    await sim.scan();
    // rect 2x3 = 6, square 1x1 = 1, circle r = 2 (scaled at startup) = 12
    assert.equal(await sim.get('sum'), 19);
    assert.equal(await sim.get('codes'), 1101);
    assert.equal(await sim.get('d1'), 60);
    assert.equal(await sim.get('d2'), 120);
    assert.equal(await sim.get('t'), 1);
    assert.equal(await sim.get('isNull'), true);
    assert.equal(await sim.get('same'), true);
    assert.equal(await sim.get('circ.scaled'), 1);
    assert.equal(await sim.get('circ.calls'), 1);
  });
});

test('OOP: calling through a NULL reference faults the CPU', { skip }, async () => {
  await withSim(`
    INTERFACE I METHOD M : INT END_METHOD END_INTERFACE
    VAR_GLOBAL r : I; x : INT; END_VAR
    ORGANIZATION_BLOCK Main
      x := r.M();
    END_ORGANIZATION_BLOCK`, async (sim) => {
    await sim.scan();
    const st = await sim.state();
    assert.equal(st.state, 'FAULT');
  });
});

test('OOP: compile-time checks', () => {
  const base = `
    INTERFACE I METHOD M : INT END_METHOD END_INTERFACE
    FUNCTION_BLOCK A IMPLEMENTS I
      METHOD M : INT M := 1; END_METHOD
      METHOD PRIVATE P END_METHOD
      METHOD FINAL F END_METHOD
    END_FUNCTION_BLOCK
  `;
  const main = (body: string, vars = 'x : A;') => `${base} VAR_GLOBAL ${vars} END_VAR ORGANIZATION_BLOCK Main ${body} END_ORGANIZATION_BLOCK`;
  assert.deepEqual(errors(main('x.M();')), []);
  assert.match(errors(main('x.P();'))[0], /PRIVATE/);
  assert.match(errors(`${base} FUNCTION_BLOCK B EXTENDS A METHOD F END_METHOD END_FUNCTION_BLOCK`)[0], /FINAL/);
  assert.match(errors(`${base} FUNCTION_BLOCK FINAL C END_FUNCTION_BLOCK FUNCTION_BLOCK D EXTENDS C END_FUNCTION_BLOCK`)[0], /FINAL/);
  assert.match(errors(`INTERFACE I METHOD M : INT END_METHOD END_INTERFACE FUNCTION_BLOCK B IMPLEMENTS I END_FUNCTION_BLOCK`)[0], /must implement method 'M'/);
  assert.match(errors(`INTERFACE I METHOD M : INT END_METHOD END_INTERFACE FUNCTION_BLOCK B IMPLEMENTS I METHOD M : REAL END_METHOD END_FUNCTION_BLOCK`)[0], /does not match/);
  assert.match(errors(`FUNCTION_BLOCK ABSTRACT B METHOD ABSTRACT M END_METHOD END_FUNCTION_BLOCK VAR_GLOBAL b1 : B; END_VAR`)[0], /abstract/);
  assert.match(errors(`FUNCTION_BLOCK B METHOD OVERRIDE M END_METHOD END_FUNCTION_BLOCK`)[0], /OVERRIDE/);
  assert.match(errors(main('r := b1;', 'r : I; b1 : TON;'))[0], /Cannot use TON/);
  assert.match(errors(`${base} FUNCTION_BLOCK X END_FUNCTION_BLOCK VAR_GLOBAL r : I; x1 : X; END_VAR ORGANIZATION_BLOCK Main r := x1; END_ORGANIZATION_BLOCK`)[0], /does not implement/);
  // recursion through a virtual call
  assert.match(errors(`INTERFACE I METHOD M END_METHOD END_INTERFACE
    FUNCTION_BLOCK B IMPLEMENTS I VAR r : I; END_VAR METHOD M r.M(); END_METHOD END_FUNCTION_BLOCK`)[0], /Recursive/);
  // CLASS: no body call
  assert.match(errors(`CLASS K METHOD M END_METHOD END_CLASS VAR_GLOBAL k1 : K; END_VAR ORGANIZATION_BLOCK Main k1(); END_ORGANIZATION_BLOCK`)[0], /is a class/);
  assert.deepEqual(errors(`CLASS K VAR n : INT; END_VAR METHOD Inc n := n + 1; END_METHOD END_CLASS VAR_GLOBAL k1 : K; END_VAR ORGANIZATION_BLOCK Main k1.Inc(); END_ORGANIZATION_BLOCK`), []);
});

test('OOP: project model (import, sources, diagnostics, folder files)', async () => {
  const { newProject, importExternalSource, compileDevice } = await import('../src/project.ts');
  const { projectToFiles, projectFromFiles } = await import('../src/projectFiles.ts');
  const project = newProject('OOP');
  const device = project.devices[0];
  const imported = importExternalSource(device, SHAPES.replace(/VAR_GLOBAL[\s\S]*$/, ''), 'shapes.scl');
  assert.deepEqual(imported.interfaces.map((i) => i.name), ['IShape', 'INamed']);
  const shape = imported.blocks.find((b) => b.name === 'Shape')!;
  assert.equal(shape.abstract, true);
  assert.deepEqual(shape.implements, ['IShape', 'INamed']);
  assert.deepEqual(shape.methods!.map((m) => m.name), ['Area', 'Scale', 'Resize', 'Code', 'Describe']);
  assert.equal(shape.methods![1].code, 'scaled := scaled + 1;\nTHIS.Resize(k := k);');
  assert.equal(shape.methods![2].access, 'PROTECTED');
  const circle = imported.blocks.find((b) => b.name === 'Circle')!;
  assert.equal(circle.extends, 'Shape');
  assert.equal(circle.code, 'calls := calls + 1;\nSUPER();');
  device.blocks.push(...imported.blocks);
  device.interfaces = imported.interfaces;
  device.tagTables[0].tags.push({ name: 'c1', dataType: '"Circle"', address: '' }, { name: 'sumArea', dataType: 'Real', address: '' });
  device.blocks[0].code = '"c1"(); "sumArea" := "c1".Describe();';
  let r = compileDevice(project, device);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));

  // an error in a method is reported on the method's code line
  circle.methods![0].code = 'Area := 3.0 * r * r;\nArea := undefinedVar;';
  r = compileDevice(project, device);
  const d = r.diagnostics.find((x) => x.severity === 'error')!;
  assert.equal(d.blockId, circle.id);
  assert.equal(d.methodId, circle.methods![0].id);
  assert.equal(d.location, 'code');
  assert.equal(d.codeLine, 2);
  circle.methods![0].code = 'Area := 3.0 * r * r;';

  const files = projectToFiles(project);
  assert.ok(files['devices/PLC_1/interfaces/IShape.json']);
  assert.equal(files['devices/PLC_1/blocks/Shape.methods/Scale.scl'], 'scaled := scaled + 1;\nTHIS.Resize(k := k);\n');
  assert.equal(files['devices/PLC_1/blocks/Shape.methods/Area.scl'], undefined, 'abstract method: no code file');
  const back = projectFromFiles(files);
  const d2 = back.devices[0];
  assert.deepEqual(d2.interfaces!.map((i) => i.name).sort(), ['INamed', 'IShape']);
  assert.equal(d2.blocks.find((b) => b.name === 'Shape')!.methods![1].code, 'scaled := scaled + 1;\nTHIS.Resize(k := k);');
  assert.equal(compileDevice(back, d2).ok, true);
});
