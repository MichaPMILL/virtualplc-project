// Builds the Studio projects of the examples (folder layout) from their SCL sources:
//   node examples/make-projects.ts
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileDevice, importExternalSource, newProject, type WatchRow } from '../sdk/src/project.ts';
import { projectToFiles } from '../sdk/src/projectFiles.ts';

const root = dirname(fileURLToPath(import.meta.url));

function build(dir: string, name: string, comment: string, watch: WatchRow[]): void {
  const project = newProject(name);
  project.comment = comment;
  project.created = '2026-01-01T00:00:00.000Z';
  const device = project.devices[0];
  device.blocks = [];
  for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith('.scl')).sort()) {
    const r = importExternalSource(device, readFileSync(join(root, dir, file), 'utf8'), file);
    device.blocks.push(...r.blocks);
    device.types.push(...r.types);
    (device.interfaces ??= []).push(...r.interfaces);
    device.tagTables[0].tags.push(...r.tags);
  }
  if (!device.interfaces?.length) delete device.interfaces;
  device.watchTables[0].rows = watch;
  // stable ids: the project files do not change when they are generated again
  let n = 0;
  const id = (prefix: string) => `${prefix}-${dir}-${++n}`;
  device.id = id('dev');
  device.tagTables.forEach((t) => (t.id = id('tt')));
  device.watchTables.forEach((t) => (t.id = id('wt')));
  device.blocks.forEach((b) => {
    b.id = id('blk');
    b.methods?.forEach((m) => (m.id = id('mth')));
  });
  device.interfaces?.forEach((i) => {
    i.id = id('ifc');
    i.methods.forEach((m) => (m.id = id('mth')));
  });
  const r = compileDevice(project, device);
  if (!r.ok) throw new Error(`${dir}: ${JSON.stringify(r.diagnostics)}`);
  const out = join(root, dir, 'project');
  rmSync(out, { recursive: true, force: true });
  for (const [path, text] of Object.entries(projectToFiles(project))) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), text);
  }
  console.log(`${dir}: ${device.blocks.length} blocks, code ${r.stats.code} bytes -> ${out}`);
}

const row = (name: string, comment?: string): WatchRow => ({ name, ...(comment ? { comment } : {}) });

build('carton-closer', 'Fermeuse de cartons',
  'Exemple POO : interface "ICylinder", vérins dérivés (EXTENDS), séquence de fermeture de cartons.', [
    row('S_PlantModel', 'démonstration : capteurs simulés'), row('S_Jam'), row('"Plant".BoxPosition'),
    row('BP_Start'), row('BP_Stop'), row('AU_Ok'), row('BP_Reset'),
    row('"Machine".Step', 'étape de la séquence'), row('BoxCount'),
    row('B_BoxAtStation'), row('B_BoxOut'), row('M_ConveyorIn'), row('M_ConveyorOut'),
    row('YV_Stopper'), row('YV_SideFlaps'), row('YV_FrontFlaps'), row('YV_PressDown'), row('YV_PressUp'), row('YV_Glue'),
    row('"Stopper".Fault'), row('"SideFlaps".Fault'), row('"FrontFlaps".Fault'), row('"Press".Fault'),
  ]);
build('traffic-lights', 'Feux tricolores',
  'Exemple sans POO : carrefour à feux avec appel piétons, détection de véhicules et mode nuit.', [
    row('S_On'), row('S_Night'), row('BP_Pedestrian'), row('B_SideVehicle'),
    row('Phase'), row('Cycles'),
    row('H_Main_Red'), row('H_Main_Amber'), row('H_Main_Green'),
    row('H_Side_Red'), row('H_Side_Amber'), row('H_Side_Green'),
    row('H_Ped_Red'), row('H_Ped_Green'), row('H_Ped_Wait'),
    row('"Timings".MainGreenMin'), row('"Timings".SideGreen'),
  ]);
