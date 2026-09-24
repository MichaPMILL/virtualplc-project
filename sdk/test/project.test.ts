import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  compileDevice, importExternalSource, importLegacyProject, loadProject, newProject, saveProject, type LegacyProject,
} from '../src/index.ts';

const root = new URL('../../', import.meta.url);

test('a new project compiles', () => {
  const p = newProject('Test');
  const r = compileDevice(p, p.devices[0]);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
});

test('errors are mapped to the block and the line of its code editor', () => {
  const p = newProject('Test');
  const d = p.devices[0];
  d.tagTables[0].tags.push({ name: 'Lamp', dataType: 'Bool', address: '%Q0.0' });
  d.blocks[0].code = 'Lamp := TRUE;\nLamp := Nope;';
  const r = compileDevice(p, d);
  assert.equal(r.ok, false);
  assert.deepEqual(r.diagnostics.map((x) => [x.blockId, x.location, x.codeLine, x.message]), [[d.blocks[0].id, 'code', 2, "Undeclared variable 'Nope'"]]);
});

test('interface errors are reported as such', () => {
  const p = newProject('Test');
  const d = p.devices[0];
  d.blocks[0].interface.temp.push({ name: 'x', dataType: 'Motor' });
  const r = compileDevice(p, d);
  assert.equal(r.diagnostics[0].location, 'interface');
  assert.match(r.diagnostics[0].message, /Unknown data type 'Motor'/);
});

test('invalid addresses in the tag table are reported', () => {
  const p = newProject('Test');
  p.devices[0].tagTables[0].tags.push({ name: 'x', dataType: 'Bool', address: '%X9' });
  const r = compileDevice(p, p.devices[0]);
  assert.equal(r.diagnostics[0].location, 'tags');
});

test('save / load round trip', () => {
  const p = newProject('Round trip');
  const loaded = loadProject(saveProject(p));
  assert.equal(loaded.name, 'Round trip');
  assert.throws(() => loadProject('{"format":"other"}'), /not a VirtualPLC project/);
});

test('imports an SCL external source', () => {
  const p = newProject('Import');
  const d = p.devices[0];
  const { blocks, tags } = importExternalSource(d, readFileSync(new URL('examples/scl/motor.scl', root), 'utf8'));
  assert.deepEqual(blocks.map((b) => `${b.name} [${b.type}${b.number}]`), ['Motor [FB1]', 'Main [OB123]', 'Motor_DB [DB1]']);
  const fb = blocks[0];
  assert.deepEqual(fb.interface.input.map((m) => `${m.name}:${m.dataType}:${m.defaultValue ?? ''}`), ['Start:Bool:', 'Stop:Bool:', 'StartDelay:Time:T#2000MS']);
  assert.deepEqual(fb.interface.static.map((m) => m.dataType), ['TON', 'R_TRIG', 'Bool']);
  assert.match(fb.code, /^REGION Start/);
  assert.equal(tags.find((t) => t.name === 'Start_Button')?.address, '%I0.0');
  // Replace the default OB1 by the imported blocks and compile
  d.blocks = blocks;
  d.tagTables[0].tags = tags;
  const r = compileDevice(p, d);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
});

test('imports a historical PHP VirtualPLC project and compiles it', () => {
  const legacy = JSON.parse(readFileSync(new URL('examples/project.json', root), 'utf8')) as LegacyProject;
  const p = importLegacyProject(legacy);
  const d = p.devices[0];
  assert.equal(d.io.length, 1);
  assert.equal(d.tagTables[0].tags.find((t) => t.name === 'AU_VoieB')?.address, '%I0.3');
  assert.equal(d.tagTables[0].tags.find((t) => t.name === 'VentilationOut')?.address, '%Q0.4');
  const r = compileDevice(p, d);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.equal(loadProject(JSON.stringify(legacy)).devices[0].blocks.length, d.blocks.length, 'loadProject detects legacy files');
});
