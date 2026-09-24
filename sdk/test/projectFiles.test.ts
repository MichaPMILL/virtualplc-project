import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  compileDevice, importExternalSource, isFolderManifest, newProject, projectFromFiles, projectToFiles, safeFileName,
} from '../src/index.ts';

const root = new URL('../../', import.meta.url);

function sampleProject() {
  const p = newProject('Station 1');
  const d = p.devices[0];
  const { blocks, tags } = importExternalSource({ ...d, blocks: [] }, readFileSync(new URL('examples/scl/motor.scl', root), 'utf8'));
  d.blocks = blocks; // the source brings its own Main OB
  d.tagTables[0].tags.push(...tags);
  d.tagTables.push({ id: 'tt-2', name: 'Alarmes', tags: [{ name: 'Alarm', dataType: 'Bool', address: '%M10.0' }], constants: [] });
  d.watchTables[0].rows.push({ name: '"Start"' });
  return p;
}

test('a project survives the folder layout round trip', () => {
  const p = sampleProject();
  const files = projectToFiles(p);
  const back = projectFromFiles(files);
  // same content (JSON drops undefined fields); blocks are stored sorted by type and number
  const norm = (x: typeof p) => {
    const c = JSON.parse(JSON.stringify({ ...x, modified: '' }));
    for (const d of c.devices) d.blocks.sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
    return c;
  };
  assert.deepEqual(norm(back), norm(p));
  assert.equal(compileDevice(back, back.devices[0]).ok, true);
});

test('one readable file per object, code in plain SCL files', () => {
  const files = projectToFiles(sampleProject());
  const paths = Object.keys(files).sort();
  assert.ok(paths.includes('Station 1.vplcproj'));
  assert.ok(paths.includes('devices/PLC_1/device.json'));
  assert.ok(paths.some((x) => x.endsWith('/blocks/Main.scl')));
  assert.ok(paths.includes('devices/PLC_1/tags/Alarmes.json'));
  assert.ok(isFolderManifest(files['Station 1.vplcproj']));
  assert.ok(!files['Station 1.vplcproj'].includes('modified'), 'no modification date (merge friendly)');
  const motor = paths.find((x) => /blocks\/Motor\.scl$/.test(x));
  assert.ok(motor && files[motor].includes('#DelayTimer('), 'code is stored as SCL text');
});

test('the layout is stable: saving twice gives the same files', () => {
  const p = sampleProject();
  assert.deepEqual(projectToFiles(projectFromFiles(projectToFiles(p))), projectToFiles(p));
});

test('unresolved merge conflicts are reported with the file name', () => {
  const files = projectToFiles(sampleProject());
  files['devices/PLC_1/tags/Alarmes.json'] = '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> origin/main\n';
  assert.throws(() => projectFromFiles(files), /Alarmes\.json: unresolved merge conflict/);
});

test('file names are safe on every OS', () => {
  assert.equal(safeFileName('Motor: "A/B"'), 'Motor_ _A_B_');
  assert.equal(safeFileName('CON'), '_CON');
  assert.equal(safeFileName('..'), '_');
});
