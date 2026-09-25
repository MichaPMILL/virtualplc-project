import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addToLibrary, compileDevice, importExternalSource, insertFromLibrary, newLibrary, newProject, outdatedCopies, parseLibrary,
  serializeLibrary, standardLibrary, projectToFiles, projectFromFiles,
} from '../src/index.ts';

const SOURCE = `TYPE "Recipe"
STRUCT
  Speed : Real;
  Count : Int;
END_STRUCT
END_TYPE
FUNCTION_BLOCK "Station"
VAR_INPUT r : "Recipe"; END_VAR
VAR_OUTPUT done : Bool; END_VAR
VAR t : TON; END_VAR
BEGIN
  t(IN := r.Count > 0, PT := T#1S);
  done := t.Q;
END_FUNCTION_BLOCK
FUNCTION_BLOCK "Line"
VAR s1 : "Station"; s2 : "Station"; END_VAR
BEGIN
  s1(); s2();
END_FUNCTION_BLOCK`;

function projectWith(source: string) {
  const p = newProject('P');
  const d = p.devices[0];
  const r = importExternalSource(d, source);
  d.blocks.push(...r.blocks);
  d.types.push(...r.types);
  return p;
}

test('library: add with dependencies, versions, insert into another CPU', () => {
  const p = projectWith(SOURCE);
  const lib = newLibrary('Machines');
  const added = addToLibrary(lib, p.devices[0], 'block', 'Line', { category: 'Stations' });
  assert.deepEqual(added.map((e) => e.name).sort(), ['Line', 'Recipe', 'Station']);
  const line = lib.elements.find((e) => e.name === 'Line')!;
  assert.deepEqual(line.dependencies, ['Station']);
  assert.deepEqual(lib.elements.find((e) => e.name === 'Station')!.dependencies, ['Recipe']);
  assert.equal(line.version, '1.0.0');

  // same content again: same version; changed: new version
  addToLibrary(lib, p.devices[0], 'block', 'Line');
  assert.equal(lib.elements.find((e) => e.name === 'Line')!.version, '1.0.0');

  // round trip through a .vplclib file
  const copy = parseLibrary(serializeLibrary(lib));
  assert.equal(copy.elements.length, 3);

  // insertion in an empty CPU: the whole tree comes, and compiles
  const q = newProject('Q');
  const d = q.devices[0];
  const r = insertFromLibrary(d, copy, 'Line');
  assert.deepEqual(r.added.sort(), ['Line', 'Recipe', 'Station']);
  assert.equal(d.blocks.find((b) => b.name === 'Line')!.library!.version, '1.0.0');
  d.blocks.find((b) => b.name === 'Main')!.code = '"Line_DB"();';
  d.blocks.push({ ...d.blocks.find((b) => b.name === 'Line')!, id: 'x', name: 'Line_DB', type: 'DB', number: 5, instanceOf: 'Line', code: '', networks: undefined, library: undefined });
  const c = compileDevice(q, d);
  assert.equal(c.ok, true, JSON.stringify(c.diagnostics));

  // new version in the library: the copy is out of date, update replaces it
  const station = p.devices[0].blocks.find((b) => b.name === 'Station')!;
  station.code += '\n  done := done AND r.Speed > 0.0;';
  addToLibrary(copy, p.devices[0], 'block', 'Station');
  assert.equal(copy.elements.find((e) => e.name === 'Station')!.version, '1.0.1');
  assert.deepEqual(outdatedCopies(d, copy), [{ name: 'Station', have: '1.0.0', latest: '1.0.1' }]);
  const u = insertFromLibrary(d, copy, 'Station');
  assert.deepEqual(u.updated, ['Station']);
  assert.deepEqual(u.unchanged, ['Recipe']);
  assert.deepEqual(outdatedCopies(d, copy), []);
});

test('library: standard library and project library saved with the project', () => {
  const std = standardLibrary();
  assert.ok(std.readOnly);
  const names = std.elements.map((e) => e.name);
  for (const n of ['VPLC_PID', 'VPLC_Cylinder', 'VPLC_Sequencer']) assert.ok(names.includes(n), n);
  const p = newProject('P');
  const d = p.devices[0];
  insertFromLibrary(d, std, 'VPLC_Cylinder');
  assert.equal(d.blocks.find((b) => b.name === 'VPLC_Cylinder')!.library!.library, std.name);
  const lib = newLibrary('P');
  addToLibrary(lib, d, 'block', 'VPLC_Cylinder');
  p.library = lib.elements;
  const back = projectFromFiles(projectToFiles(p));
  assert.equal(back.library?.[0].name, 'VPLC_Cylinder');
  assert.equal(back.devices[0].blocks.find((b) => b.name === 'VPLC_Cylinder')!.library!.element, 'std-VPLC_Cylinder');
});
