// The example programs (examples/carton-closer, examples/traffic-lights), run in the VM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { simAvailable, withSim, type Sim } from './sim.ts';

const skip = simAvailable ? false : 'build runtime/ first';
const source = (dir: string) => {
  const url = new URL(`../../examples/${dir}/`, import.meta.url);
  return readdirSync(url).filter((f) => f.endsWith('.scl')).sort().map((f) => readFileSync(new URL(f, url), 'utf8')).join('\n');
};

/** Pneumatic cylinder of the plant model: position 0 (in) .. 1 (out), 300 ms stroke */
class CylinderModel {
  pos = 0;
  readonly valve: string;
  readonly out: string;
  readonly inn: string | null;
  readonly valveIn: string | null;
  constructor(valve: string, out: string, inn: string | null, valveIn: string | null = null) {
    this.valve = valve;
    this.out = out;
    this.inn = inn;
    this.valveIn = valveIn;
  }
  async step(sim: Sim, ms: number, jammed = false): Promise<void> {
    const extend = (await sim.get(this.valve)) as boolean;
    const retract = this.valveIn ? (await sim.get(this.valveIn)) as boolean : !extend;
    if (!jammed) {
      if (extend && !retract) this.pos = Math.min(1, this.pos + ms / 300);
      if (retract && !extend) this.pos = Math.max(0, this.pos - ms / 300);
    }
    await sim.set(this.out, this.pos >= 1);
    if (this.inn) await sim.set(this.inn, this.pos <= 0);
  }
}

test('example: carton closing machine (OOP)', { skip }, async () => {
  await withSim(source('carton-closer'), async (sim) => {
    const cyl = {
      stopper: new CylinderModel('YV_Stopper', 'B_Stopper_Out', 'B_Stopper_In'),
      side: new CylinderModel('YV_SideFlaps', 'B_SideFlaps_Out', 'B_SideFlaps_In'),
      front: new CylinderModel('YV_FrontFlaps', 'B_FrontFlaps_Out', null),
      press: new CylinderModel('YV_PressDown', 'B_Press_Out', 'B_Press_In', 'YV_PressUp'),
    };
    // box position on the conveyors: 0 = entry, 100 = at the stopper, 200 = at the exit sensor
    let box = 0;
    let jam = false;
    let tick = 0;
    const glued: number[] = [];
    const run = async (ms: number) => {
      for (let t = 0; t < ms; t += 10) {
        for (const [name, c] of Object.entries(cyl)) await c.step(sim, 10, jam && name === 'side');
        const conveyorIn = (await sim.get('M_ConveyorIn')) as boolean;
        const conveyorOut = (await sim.get('M_ConveyorOut')) as boolean;
        if (conveyorIn && box < 100) box = Math.min(box + 2, cyl.stopper.pos >= 1 ? 100 : 250);
        if (conveyorOut && box >= 100 && (box > 100 || cyl.stopper.pos <= 0)) box += 2;   // past the stopper once released
        if (box >= 250) box = 0;   // next box arrives at the entry
        await sim.set('B_BoxAtStation', box >= 100 && box < 110);
        await sim.set('B_BoxOut', box >= 200 && box < 220);
        if (await sim.get('YV_Glue')) glued.push(box);
        if (process.env.DEBUG_EX && (tick++ % 25) === 0) console.log(tick * 10, await sim.get('"Machine".Step'), box, Object.values(cyl).map((c) => c.pos.toFixed(1)).join(','));
        await sim.scan(1, 10);
      }
    };
    await sim.set('BP_Stop', true);
    await sim.set('AU_Ok', true);
    await run(1000);
    assert.equal(await sim.get('"Machine".Step'), 10, 'initialised: idle');
    await sim.set('BP_Start', true);
    await run(50);
    await sim.set('BP_Start', false);
    assert.equal(await sim.get('H_Running'), true);
    await run(15000);
    const count = (await sim.get('BoxCount')) as number;
    assert.ok(count >= 3, `boxes closed: ${count}`);
    assert.ok(glued.length > 0 && glued.every((b) => b >= 100 && b < 110), 'glue only while the box is at the station');

    // the side flaps cylinder jams: fault, immediate stop, blinking lamp
    jam = true;
    await run(4000);
    assert.equal(await sim.get('"Machine".Step'), 99);
    assert.equal(await sim.get('M_ConveyorIn'), false);
    assert.equal(await sim.get('H_Running'), false);
    const lamp = new Set<boolean>();
    for (let i = 0; i < 12; i++) {
      await run(100);
      lamp.add((await sim.get('H_Fault')) as boolean);
    }
    assert.equal(lamp.size, 2, 'fault lamp blinks');
    // repair, acknowledge, restart
    jam = false;
    await sim.set('BP_Reset', true);
    await run(20);
    await sim.set('BP_Reset', false);
    await run(1500);
    assert.equal(await sim.get('"Machine".Step'), 10);
    await sim.set('BP_Start', true);
    await run(50);
    await sim.set('BP_Start', false);
    await run(6000);
    assert.ok(((await sim.get('BoxCount')) as number) > count);
    // stop at the end of the cycle
    await sim.set('BP_Stop', false);
    await run(50);
    await sim.set('BP_Stop', true);
    await run(6000);
    assert.equal(await sim.get('"Machine".Step'), 10);
    assert.equal(await sim.get('H_Running'), false);
  }, { cycleMs: 10 });
});

test('example: traffic lights (no OOP)', { skip }, async () => {
  await withSim(source('traffic-lights'), async (sim) => {
    const lights = async () => {
      const on = async (n: string) => ((await sim.get(n)) ? n.replace(/^H_/, '') : '');
      return (await Promise.all(['H_Main_Red', 'H_Main_Amber', 'H_Main_Green', 'H_Side_Red', 'H_Side_Amber', 'H_Side_Green', 'H_Ped_Red', 'H_Ped_Green'].map(on))).filter(Boolean).join(' ');
    };
    const run = (ms: number) => sim.scan(ms / 10, 10);
    // switched off: flashing amber
    await run(2000);
    assert.equal(await sim.get('Phase'), 0);
    // on: 5 s flashing, 2 s all red, then main green
    await sim.set('S_On', true);
    await run(5100);
    assert.equal(await lights(), 'Main_Red Side_Red Ped_Red');
    await run(2000);
    assert.equal(await lights(), 'Main_Green Side_Red Ped_Red');
    // no demand: main road stays green
    await run(60000);
    assert.equal(await sim.get('Phase'), 2);
    // pedestrian request: served after the minimal green
    await sim.set('BP_Pedestrian', true);
    await run(100);
    await sim.set('BP_Pedestrian', false);
    assert.equal(await sim.get('H_Ped_Wait'), true);
    await run(100);
    assert.equal(await lights(), 'Main_Amber Side_Red Ped_Red');
    await run(3000);
    assert.equal(await lights(), 'Main_Red Side_Red Ped_Red');
    await run(2000);
    assert.equal(await lights(), 'Main_Red Side_Green Ped_Green');
    assert.equal(await sim.get('H_Ped_Wait'), false);
    await run(7000);
    assert.equal(await lights(), 'Main_Red Side_Green Ped_Red');
    await run(3000);
    assert.equal(await lights(), 'Main_Red Side_Amber Ped_Red');
    await run(3000);
    assert.equal(await lights(), 'Main_Red Side_Red Ped_Red');
    await run(2000);
    assert.equal(await lights(), 'Main_Green Side_Red Ped_Red');
    assert.equal(await sim.get('Cycles'), 1);
    // vehicle on the side road: next cycle after 20 s of main green
    await sim.set('B_SideVehicle', true);
    await run(100);
    await sim.set('B_SideVehicle', false);
    await run(19000);
    assert.equal(await sim.get('Phase'), 2);
    await run(1100);
    assert.equal(await sim.get('Phase'), 3);
    // night mode: flashing amber, pedestrians off
    await sim.set('S_Night', true);
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      await run(200);
      seen.add(await lights());
    }
    assert.deepEqual([...seen].sort(), ['', 'Main_Amber Side_Amber']);
  }, { cycleMs: 10 });
});

test('example projects open in the Studio and compile', async () => {
  const { projectFromFiles } = await import('../src/projectFiles.ts');
  const { compileDevice } = await import('../src/project.ts');
  const { readdirSync: ls, statSync } = await import('node:fs');
  for (const dir of ['carton-closer', 'traffic-lights']) {
    const base = new URL(`../../examples/${dir}/project/`, import.meta.url).pathname;
    const files: Record<string, string> = {};
    const walk = (rel: string) => {
      for (const f of ls(base + rel)) {
        const p = rel ? `${rel}/${f}` : f;
        if (statSync(base + p).isDirectory()) walk(p);
        else files[p] = readFileSync(base + p, 'utf8');
      }
    };
    walk('');
    const project = projectFromFiles(files);
    const r = compileDevice(project, project.devices[0]);
    assert.equal(r.ok, true, `${dir}: ${JSON.stringify(r.diagnostics)} (regenerate with node examples/make-projects.ts)`);
  }
});
