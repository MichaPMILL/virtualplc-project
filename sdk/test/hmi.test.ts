// Variables and data blocks exposed to HMIs, CPU services, IO-Link masters in the image.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDevice, HMI_STRING, HMI_TIME, newProject, readImage, Section } from '../src/index.ts';

function project() {
  const p = newProject('Hmi');
  const d = p.devices[0];
  d.tagTables[0].tags.push(
    { name: 'Start', dataType: 'Bool', address: '%I0.0' },
    { name: 'Speed', dataType: 'Int', address: '%MW10', hmiWritable: false },
    { name: 'Secret', dataType: 'DInt', address: '', hmiVisible: false },
    { name: 'Label', dataType: 'String[10]', address: '' },
  );
  d.blocks.push({
    id: 'db1', name: 'Recipe', type: 'DB', number: 5, interface: { input: [], output: [], inout: [], static: [], temp: [], constant: [] }, code: '',
    members: [
      { name: 'Values', dataType: 'Array[0..2] of Real' },
      { name: 'Delay', dataType: 'Time', hmiWritable: false },
      { name: 'Part', dataType: 'Struct', members: [{ name: 'Id', dataType: 'Int' }, { name: 'Hidden', dataType: 'Bool', hmiVisible: false }] },
    ],
  });
  d.services = { opcua: { enabled: true, port: 4841, write: true, anonymous: false }, s7: { enabled: true, write: false } };
  d.io.push({
    kind: 'iolink-master', name: 'Master', host: '10.0.0.5', ports: [
      { port: 1, inRegister: 1000, inByte: 10, inLength: 4, outRegister: 2000, outByte: 20, outLength: 2 },
    ],
  });
  return p;
}

test('flattened HMI variables honour visibility and write access', () => {
  const p = project();
  const r = compileDevice(p, p.devices[0]);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const byPath = new Map(r.hmiSymbols!.map((s) => [s.path.join('.'), s]));
  assert.deepEqual([...byPath.keys()].sort(), [
    'Label', 'Recipe.Delay', 'Recipe.Part.Id', 'Recipe.Values[0]', 'Recipe.Values[1]', 'Recipe.Values[2]', 'Speed', 'Start',
  ]);
  assert.equal(byPath.get('Start')!.writable, false, 'inputs are read-only');
  assert.equal(byPath.get('Speed')!.writable, false);
  assert.equal(byPath.get('Recipe.Values[1]')!.writable, true);
  assert.equal(byPath.get('Recipe.Delay')!.type, HMI_TIME);
  assert.equal(byPath.get('Label')!.type, HMI_STRING);
  assert.equal(byPath.get('Label')!.size, 12);
  assert.deepEqual(byPath.get('Recipe.Values[1]')!.path, ['Recipe', 'Values[1]']);
  assert.deepEqual(r.dbs!.map((d) => [d.number, d.name, d.size]), [[5, 'Recipe', 12 + 4 + 3]]);
  assert.equal(byPath.get('Recipe.Values[0]')!.offset, r.dbs![0].offset, 'DB members start at the DB offset');
});

test('image carries symbols, data blocks, services and IO-Link masters', () => {
  const p = project();
  const r = compileDevice(p, p.devices[0]);
  const img = readImage(r.image!);
  for (const s of [Section.SYMS, Section.DBS, Section.SERVICES, Section.IOCONF]) assert.ok(img.sections.get(s)?.length, `section ${s}`);
  const svc = img.sections.get(Section.SERVICES)!;
  const v = new DataView(svc.buffer, svc.byteOffset, svc.byteLength);
  assert.equal(v.getUint16(0, true), 4841);
  assert.equal(v.getUint8(2), 1 | 2, 'OPC UA enabled, writes allowed, no anonymous access');
  assert.equal(v.getUint16(3, true), 102);
  assert.equal(v.getUint8(5), 1, 'S7 enabled, read only');
  assert.ok(r.stats.inputs >= 14 && r.stats.outputs >= 22, 'IO-Link process data sizes the process image');
});
