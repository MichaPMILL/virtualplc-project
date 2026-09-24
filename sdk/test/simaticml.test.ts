// Import of SimaticML exports (blocks in LAD and SCL, instance DB, tag table, PLC data type).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileDevice, importSimaticMl, isSimaticMl, newProject, type Device } from '../src/index.ts';
import { simAvailable, withSim } from './sim.ts';

const dir = new URL('../../examples/simaticml/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, dir), 'utf8');

function importAll(device: Device) {
  const warnings: string[] = [];
  for (const f of ['Recipe.xml', 'Tags.xml', 'Conveyor.xml', 'Conveyor_DB.xml', 'Main.xml']) {
    const text = read(f);
    assert.ok(isSimaticMl(text), f);
    const r = importSimaticMl(device, text);
    warnings.push(...r.warnings);
    device.types.push(...r.types);
    device.tagTables.push(...r.tagTables);
    for (const b of r.blocks) {
      const i = device.blocks.findIndex((x) => x.name === b.name);
      if (i >= 0) device.blocks[i] = { ...b, id: device.blocks[i].id }; else device.blocks.push(b);
    }
  }
  return warnings;
}

test('SimaticML: blocks, networks, interface, tags and types', () => {
  const p = newProject('Import');
  const d = p.devices[0];
  assert.deepEqual(importAll(d), []);
  const fb = d.blocks.find((b) => b.name === 'Conveyor')!;
  assert.equal(fb.type, 'FB');
  assert.equal(fb.number, 3);
  assert.equal(fb.language, 'LAD');
  assert.equal(fb.comment, 'Convoyeur avec démarrage temporisé');
  assert.deepEqual(fb.interface.static.map((m) => `${m.name}:${m.dataType}`), ['StartTimer:TON', 'Starts:CTU', 'StartEdge:Bool', 'Latched:Bool']);
  assert.equal(fb.interface.input[2].defaultValue, 'T#2S');
  assert.equal(fb.interface.input[1].comment, 'Arrêt (contact NF)');
  const [n1, n2, n3] = fb.networks!;
  assert.equal(n1.title, 'Auto-maintien');
  // (Start OR Latched) AND NOT Stop -> Latched
  assert.deepEqual(n1.elements.map((e) => e.kind), ['branch', 'contact', 'coil']);
  // TON with two parallel coils on Q
  const ton = n2.elements.find((e) => e.kind === 'box');
  assert.equal(ton?.kind === 'box' && `${ton.box} ${ton.instance} ${ton.inputs.PT}`, 'TON #StartTimer #Delay');
  assert.equal(n2.elements.at(-1)?.kind, 'branch');
  const ctu = n3.elements.find((e) => e.kind === 'box');
  assert.deepEqual(ctu?.kind === 'box' && [ctu.inputs, ctu.outputs], [{ R: '#Stop', PV: '1000' }, { CV: '#Count' }]);
  const main = d.blocks.find((b) => b.name === 'Main')!;
  assert.equal(main.code, [
    '"Conveyor_DB"(Start := "Start_Button", Stop := "Stop_Button");',
    '// vitesse en tr/min',
    '#speed := INT_TO_REAL("Conveyor_DB".Count) * 2.5;',
    'IF %M10.1 THEN',
    '    "Speed_Display" := #speed;',
    'END_IF;',
  ].join('\n'));
  const tags = d.tagTables.find((t) => t.name === 'Convoyeur')!;
  assert.deepEqual(tags.tags.map((t) => `${t.name} ${t.address}`), ['Start_Button %I0.0', 'Stop_Button %I0.1', 'Lamp %Q0.0', 'Speed_Display %MD20']);
  assert.equal(tags.tags[0].comment, 'Bouton marche');
  assert.equal(tags.tags[3].hmiWritable, false);
  assert.deepEqual(tags.constants, [{ name: 'MaxStarts', dataType: 'Int', value: '1000' }]);
  assert.deepEqual(d.types[0].members.map((m) => m.dataType), ['String[20]', 'Real', 'Struct']);
  assert.equal(d.blocks.find((b) => b.name === 'Conveyor_DB')?.instanceOf, 'Conveyor');
});

test('SimaticML: the imported program compiles and runs', { skip: simAvailable ? false : 'build runtime/ first' }, async () => {
  const p = newProject('Import');
  const d = p.devices[0];
  importAll(d);
  const r = compileDevice(p, d);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  await withSim(r.sources.map((s) => s.text).join('\n'), async (sim) => {
    await sim.set('Start_Button', true);
    await sim.scan(1, 10);
    assert.equal(await sim.get('"Conveyor_DB".Latched'), true);
    assert.equal(await sim.get('"Conveyor_DB".Count'), 1);
    await sim.set('Start_Button', false);
    await sim.scan(1, 1000);
    assert.equal(await sim.get('Lamp'), false);
    await sim.scan(1, 1100);
    assert.equal(await sim.get('Lamp'), true);
    assert.equal(await sim.get('"Conveyor_DB".Running'), true);
    await sim.set('Stop_Button', true);
    await sim.scan(1, 10);
    assert.equal(await sim.get('"Conveyor_DB".Latched'), false);
    assert.equal(await sim.get('"Conveyor_DB".Count'), 0);
  });
});

test('SimaticML: unsupported networks are reported, not silently dropped', () => {
  const p = newProject('Import');
  const xml = read('Conveyor.xml').replace('<Part Name="Coil" UId="28" />', '<Part Name="Wibble" UId="28" />');
  const r = importSimaticMl(p.devices[0], xml);
  assert.match(r.warnings[0], /réseau 1 : instruction Wibble not supported/);
  assert.equal(r.blocks[0].networks![0].elements.length, 0);
});
