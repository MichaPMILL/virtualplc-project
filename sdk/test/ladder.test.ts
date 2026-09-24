// Ladder (LAD) networks: translation to SCL and execution by the C++ VM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDevice, ladderToScl, newProject, projectFromFiles, projectToFiles, type LadElement, type LadNetwork } from '../src/index.ts';
import { simAvailable, withSim } from './sim.ts';

const skip = simAvailable ? false : 'build runtime/ first (cmake -S runtime -B runtime/build && cmake --build runtime/build)';

let n = 0;
const no = (operand: string): LadElement => ({ kind: 'contact', id: `c${++n}`, type: 'no', operand });
const nc = (operand: string): LadElement => ({ kind: 'contact', id: `c${++n}`, type: 'nc', operand });
const coil = (operand: string, type: 'normal' | 'set' | 'reset' | 'negated' = 'normal'): LadElement => ({ kind: 'coil', id: `q${++n}`, type, operand });
const branch = (...branches: LadElement[][]): LadElement => ({ kind: 'branch', id: `b${++n}`, branches });
const box = (name: string, inputs: Record<string, string>, outputs: Record<string, string> = {}, instance?: string): LadElement =>
  ({ kind: 'box', id: `x${++n}`, box: name, inputs, outputs, instance });
const net = (...elements: LadElement[]): LadNetwork => ({ id: `n${++n}`, elements });

test('series and parallel contacts translate to AND / OR', () => {
  const r = ladderToScl([net(branch([no('"Start"')], [no('"Motor"')]), nc('"Stop"'), coil('"Motor"'))]);
  assert.equal(r.code, ['// Network 1', '"Motor" := ("Start" OR "Motor") AND NOT "Stop";'].join('\n'));
  assert.deepEqual(r.temps, []);
});

test('missing operands are reported with their network and element', () => {
  const c = no('');
  assert.throws(() => ladderToScl([net(coil('"A"')), net(c, coil('"B"'))]), (e: Error & { network?: number; element?: string }) =>
    e.network === 1 && e.element === c.id && /operand missing/.test(e.message));
});

function ladderProject(networks: LadNetwork[], temps: Array<[string, string]> = [], statics: Array<[string, string]> = []) {
  const p = newProject('LAD');
  const d = p.devices[0];
  d.tagTables[0].tags.push(
    { name: 'Start', dataType: 'Bool', address: '%I0.0' },
    { name: 'Stop', dataType: 'Bool', address: '%I0.1' },
    { name: 'Motor', dataType: 'Bool', address: '%Q0.0' },
    { name: 'Lamp', dataType: 'Bool', address: '%Q0.1' },
    { name: 'Count', dataType: 'Int', address: '%MW10' },
    { name: 'Total', dataType: 'Int', address: '%MW12' },
    { name: 'High', dataType: 'Bool', address: '%M1.0' },
    { name: 'Edge', dataType: 'Bool', address: '%M1.1' },
    { name: 'Pulses', dataType: 'Int', address: '%MW14' },
  );
  const fb = { ...d.blocks[0], id: 'fb', name: 'Logic', type: 'FB' as const, number: 1, language: 'LAD' as const, code: '', networks };
  fb.interface = { ...fb.interface, temp: temps.map(([name, dataType]) => ({ name, dataType })), static: statics.map(([name, dataType]) => ({ name, dataType })) };
  d.blocks[0].code = '"Logic_DB"();';
  d.blocks.push(fb, { ...d.blocks[0], id: 'db', name: 'Logic_DB', type: 'DB', number: 1, code: '', instanceOf: 'Logic' });
  return { p, d };
}

test('LAD blocks compile through the project; errors point to the network', () => {
  const { p, d } = ladderProject([net(no('"Start"'), coil('"Motor"')), net(no('"Nope"'), coil('"Lamp"'))]);
  const r = compileDevice(p, d);
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics[0].network, 1);
  assert.equal(r.diagnostics[0].element, (d.blocks[1].networks![1].elements[0]).id);
  assert.match(r.diagnostics[0].message, /^Network 2: .*Nope/);
});

test('LAD networks are stored in the block file of the folder layout', () => {
  const { p } = ladderProject([net(no('"Start"'), coil('"Motor"'))]);
  const files = projectToFiles(p);
  assert.equal(Object.keys(files).some((f) => f.endsWith('/Logic.scl')), false);
  const back = projectFromFiles(files).devices[0].blocks.find((b) => b.name === 'Logic')!;
  assert.equal(back.language, 'LAD');
  assert.deepEqual(back.networks, p.devices[0].blocks.find((b) => b.name === 'Logic')!.networks);
});

test('LAD program runs on the VM: latch, timer, counter, compare, move, edge', { skip }, async () => {
  const { p, d } = ladderProject([
    // self-holding motor
    net(branch([no('"Start"')], [no('"Motor"')]), nc('"Stop"'), coil('"Motor"')),
    // lamp on 100 ms after the motor
    net(no('"Motor"'), box('TON', { PT: 'T#100MS' }, {}, '#Delay'), coil('"Lamp"')),
    // count motor starts, High when the count is >= 2
    net(no('"Motor"'), box('CTU', { R: '"Stop"', PV: '5' }, { CV: '"Count"' }, '#Starts')),
    net(box('CMP>=', { IN1: '"Count"', IN2: '2' }), coil('"High"')),
    // Total := Count * 10 when the motor runs
    net(no('"Motor"'), box('MUL', { IN1: '"Count"', IN2: '10' }, { OUT: '"Total"' })),
    // rising edge of Start counted with ADD
    net({ kind: 'contact', id: 'pe', type: 'p', operand: '"Start"', edge: '"Edge"' }, box('ADD', { IN1: '"Pulses"', IN2: '1' }, { OUT: '"Pulses"' })),
  ], [], [['Delay', 'TON'], ['Starts', 'CTU']]);
  const r = compileDevice(p, d);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  await withSim(r.sources.map((s) => s.text).join('\n'), async (sim) => {
    await sim.set('Start', true);
    await sim.scan(1, 10);
    assert.equal(await sim.get('Motor'), true);
    assert.equal(await sim.get('Lamp'), false);
    assert.equal(await sim.get('Count'), 1);
    assert.equal(await sim.get('Pulses'), 1);
    await sim.set('Start', false);
    await sim.scan(1, 50);
    assert.equal(await sim.get('Motor'), true, 'self-holding');
    await sim.scan(1, 60);
    assert.equal(await sim.get('Lamp'), true, 'TON elapsed');
    assert.equal(await sim.get('Total'), 10);
    assert.equal(await sim.get('High'), false);
    assert.equal(await sim.get('Pulses'), 1, 'edge counted once');

    await sim.set('Stop', true);
    await sim.scan(1, 10);
    assert.equal(await sim.get('Motor'), false);
    assert.equal(await sim.get('Lamp'), false);
    assert.equal(await sim.get('Count'), 0, 'counter reset');
    await sim.set('Stop', false);
    for (const _ of [1, 2]) {
      await sim.set('Start', true);
      await sim.scan(1, 10);
      await sim.set('Start', false);
      await sim.set('Stop', true);
      await sim.scan(1, 10);
      await sim.set('Stop', false);
    }
    await sim.set('Start', true);
    await sim.scan(1, 10);
    assert.equal(await sim.get('Pulses'), 4);
  });
});
