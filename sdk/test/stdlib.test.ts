// VirtualPLC standard library: every block run in the VM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_LIBRARY } from '../src/stdlib.ts';
import { simAvailable, withSim } from './sim.ts';

const skip = simAvailable ? false : 'build runtime/ first';
const lib = STANDARD_LIBRARY.map((e) => e.source).join('\n');
const approx = (actual: unknown, expected: number, eps = 0.05) =>
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= eps, `${actual} ≈ ${expected}`);

const program = (vars: string, body: string) => `${lib}
VAR_GLOBAL ${vars} END_VAR
ORGANIZATION_BLOCK "Main"
BEGIN
${body}
END_ORGANIZATION_BLOCK`;

test('stdlib: blink, debounce, hysteresis', { skip }, async () => {
  await withSim(program(`
      en : Bool; b : "VPLC_Blink"; lamp : Bool;
      raw : Bool; deb : "VPLC_Debounce"; clean : Bool;
      level : Real; hy : "VPLC_Hysteresis"; pump : Bool;`, `
    b(Enable := en, TimeOn := T#300MS, TimeOff := T#100MS, Q => lamp);
    deb(In := raw, Delay := T#50MS, Q => clean);
    hy(Value := level, OnLevel := 80.0, OffLevel := 20.0, Q => pump);`), async (sim) => {
    await sim.scan(10, 10);
    assert.equal(await sim.get('lamp'), false);
    await sim.set('en', true);
    const trace: boolean[] = [];
    for (let i = 0; i < 80; i++) {
      await sim.scan(1, 10);
      trace.push((await sim.get('lamp')) as boolean);
    }
    const on = trace.filter(Boolean).length;
    assert.ok(on > 50 && on < 70, `lamp on ${on}/80 (75 % duty cycle)`);
    // debounce: pulses shorter than 50 ms are ignored
    await sim.set('raw', true);
    await sim.scan(3, 10);
    await sim.set('raw', false);
    await sim.scan(10, 10);
    assert.equal(await sim.get('clean'), false);
    await sim.set('raw', true);
    await sim.scan(7, 10);
    assert.equal(await sim.get('clean'), true);
    // hysteresis
    for (const [v, q] of [[50, false], [85, true], [50, true], [15, false], [50, false]] as const) {
      await sim.set('level', v);
      await sim.scan();
      assert.equal(await sim.get('pump'), q, `level ${v}`);
    }
  });
});

test('stdlib: ramp and PID', { skip }, async () => {
  await withSim(program(`
      sp : Real; r : "VPLC_Ramp"; out : Real; done : Bool;
      pv : Real; pid : "VPLC_PID"; y : Real; man : Bool;`, `
    r(Setpoint := sp, RiseRate := 10.0, FallRate := 50.0, Out => out, Done => done);
    // first-order process: pv follows y with a 1 s time constant (10 ms cycle)
    pid(Setpoint := 50.0, ProcessValue := pv, Kp := 2.0, Ti := T#2S, OutMin := 0.0, OutMax := 100.0, Manual := man, ManualValue := 30.0, Output => y);
    pv := pv + (y - pv) * 0.01;`), async (sim) => {
    await sim.scan(1, 10);
    await sim.set('sp', 20);
    await sim.scan(100, 10);   // 1 s at 10 units/s
    approx(await sim.get('out'), 10, 0.2);
    await sim.scan(150, 10);
    assert.equal(await sim.get('out'), 20);
    assert.equal(await sim.get('done'), true);
    await sim.set('sp', 0);
    await sim.scan(20, 10);    // 0.2 s at 50 units/s
    approx(await sim.get('out'), 10, 0.6);
    // PID: settles on the setpoint, no overshoot beyond the output limits
    await sim.scan(3000, 10);
    approx(await sim.get('pv'), 50, 0.5);
    // manual mode: output = manual value, bumpless back to automatic
    await sim.set('man', true);
    await sim.scan(1, 10);
    approx(await sim.get('y'), 30, 0.01);
    await sim.set('man', false);
    await sim.scan(1, 10);
    approx(await sim.get('y'), 30, 1);
  });
});

test('stdlib: analog scaling, moving average, operating hours', { skip }, async () => {
  await withSim(program(`
      raw : Int; t : Real; tb : Real; back : Int; backb : Int;
      v : Real; avg : "VPLC_MovingAverage"; mean : Real;
      run : Bool; hours : "VPLC_OperatingHours"; h : DInt; m : Int; s : DInt; starts : DInt;`, `
    t := "VPLC_Scale"(Raw := raw, Low := -50.0, High := 150.0, Bipolar := FALSE);
    tb := "VPLC_Scale"(Raw := raw, Low := -10.0, High := 10.0, Bipolar := TRUE);
    back := "VPLC_Unscale"(Value := t, Low := -50.0, High := 150.0, Bipolar := FALSE);
    backb := "VPLC_Unscale"(Value := tb, Low := -10.0, High := 10.0, Bipolar := TRUE);
    avg(Value := v, Samples := 4, Average => mean);
    hours(Running := run, Hours => h, Minutes => m, TotalSeconds => s, Starts => starts);`), async (sim) => {
    await sim.set('raw', 13824);
    await sim.scan();
    approx(await sim.get('t'), 50, 0.001);
    approx(await sim.get('tb'), 5, 0.001);
    assert.equal(await sim.get('back'), 13824);
    assert.equal(await sim.get('backb'), 13824);
    for (const x of [10, 20, 30, 40, 50, 60]) {
      await sim.set('v', x);
      await sim.scan();
    }
    approx(await sim.get('mean'), 45, 0.001);   // (30+40+50+60)/4
    await sim.set('run', true);
    await sim.scan(4, 1000 * 60 * 30);            // start + 1 h 30 min
    await sim.set('run', false);
    await sim.scan();
    await sim.set('run', true);
    await sim.scan(2, 1000);
    assert.equal(await sim.get('h'), 1);
    assert.equal(await sim.get('starts'), 2);
    assert.ok(((await sim.get('s')) as number) >= 5400);
  });
});

test('stdlib: motor and valve', { skip }, async () => {
  await withSim(program(`
      start : Bool; stop : Bool; fb : Bool; trip : Bool; reset : Bool; mot : "VPLC_Motor"; k : Bool; alarm : Bool; code : Int;
      open : Bool; lsOpen : Bool; lsClosed : Bool := TRUE; valve : "VPLC_Valve"; coil : Bool; valveAlarm : Bool;`, `
    mot(Start := start, Stop := stop, Feedback := fb, Trip := trip, Reset := reset, FeedbackTime := T#1S, Run => k, Alarm => alarm, AlarmCode => code);
    valve(Open := open, OpenedSwitch := lsOpen, ClosedSwitch := lsClosed, TravelTime := T#2S, Output => coil, Alarm => valveAlarm);`), async (sim) => {
    await sim.set('start', true);
    await sim.scan();
    await sim.set('start', false);
    assert.equal(await sim.get('k'), true);
    await sim.set('fb', true);
    await sim.scan(200, 10);
    assert.equal(await sim.get('alarm'), false);
    await sim.set('trip', true);   // thermal overload
    await sim.scan();
    assert.equal(await sim.get('k'), false);
    assert.equal(await sim.get('code'), 1);
    await sim.set('trip', false);
    await sim.set('fb', false);
    await sim.set('reset', true);
    await sim.scan();
    await sim.set('reset', false);
    assert.equal(await sim.get('alarm'), false);
    // no feedback after the start: alarm 2
    await sim.set('start', true);
    await sim.scan();
    await sim.set('start', false);
    await sim.scan(110, 10);
    assert.equal(await sim.get('alarm'), true);
    assert.equal(await sim.get('code'), 2);
    assert.equal(await sim.get('k'), false);
    // valve: opens in time, then gets stuck while closing
    await sim.set('open', true);
    await sim.scan(50, 10);
    assert.equal(await sim.get('coil'), true);
    await sim.set('lsClosed', false);
    await sim.set('lsOpen', true);
    await sim.scan(300, 10);
    assert.equal(await sim.get('valveAlarm'), false);
    await sim.set('open', false);
    await sim.set('lsOpen', false);
    await sim.scan(250, 10);
    assert.equal(await sim.get('valveAlarm'), true);
  });
});

test('stdlib: pneumatic cylinder (double acting, auto / manual, faults)', { skip }, async () => {
  await withSim(program(`
      auto : Bool := TRUE; work : Bool; home : Bool; mw : Bool; mh : Bool; en : Bool := TRUE; sw : Bool; sh : Bool := TRUE; rst : Bool;
      cyl : "VPLC_Cylinder"; yWork : Bool; yHome : Bool; atW : Bool; atH : Bool; flt : Bool; code : Int;
      one : "VPLC_Cylinder"; y1 : Bool; at1 : Bool;`, `
    cyl(Auto := auto, CmdWork := work, CmdHome := home, ManWork := mw, ManHome := mh, Enable := en, WorkSensor := sw, HomeSensor := sh,
        TravelTime := T#500MS, Reset := rst, CoilWork => yWork, CoilHome => yHome, AtWork => atW, AtHome => atH, Fault => flt, FaultCode => code);
    one(CmdWork := work, UseWorkSensor := FALSE, UseHomeSensor := FALSE, DoubleActing := FALSE, NoSensorTime := T#200MS, CoilWork => y1, AtWork => at1);`), async (sim) => {
    await sim.scan(2, 10);
    assert.equal(await sim.get('atH'), true);
    assert.equal(await sim.get('yHome'), true);
    // automatic: go to work, sensors follow
    await sim.set('work', true);
    await sim.scan(1, 10);
    assert.equal(await sim.get('yWork'), true);
    assert.equal(await sim.get('yHome'), false);
    await sim.set('sh', false);
    await sim.set('sw', true);
    await sim.scan(1, 10);
    assert.equal(await sim.get('atW'), true);
    // single acting without sensors: position after NoSensorTime
    await sim.scan(25, 10);
    assert.equal(await sim.get('y1'), true);
    assert.equal(await sim.get('at1'), true);
    // manual: « rentrer » button, but the cylinder is stuck: fault 2 after TravelTime
    await sim.set('auto', false);
    await sim.set('mh', true);
    await sim.scan(1, 10);
    await sim.set('mh', false);
    assert.equal(await sim.get('yHome'), true);
    await sim.scan(60, 10);
    assert.equal(await sim.get('flt'), true);
    assert.equal(await sim.get('code'), 2);
    assert.equal(await sim.get('yHome'), false);
    // the cylinder comes back, reset
    await sim.set('sw', false);
    await sim.set('sh', true);
    await sim.set('rst', true);
    await sim.scan(1, 10);
    await sim.set('rst', false);
    await sim.scan(1, 10);
    assert.equal(await sim.get('flt'), false);
    assert.equal(await sim.get('atH'), true);
    // interlock: no movement
    await sim.set('en', false);
    await sim.set('mw', true);
    await sim.scan(1, 10);
    assert.equal(await sim.get('yWork'), false);
  });
});

test('stdlib: sequencer (automatic, cycle by cycle, step by step, stop at end of cycle)', { skip }, async () => {
  await withSim(program(`
      mode : Int := 1; start : Bool; stop : Bool; pulse : Bool; t : Bool; hold : Bool; rst : Bool;
      seq : "VPLC_Sequencer"; step : Int; waiting : Bool; ends : Int;`, `
    seq(Mode := mode, Start := start, Stop := stop, StepPulse := pulse, Transition := t, LastStep := 3, Hold := hold, Reset := rst,
        Step => step, WaitingValidation => waiting);
    IF seq.CycleEnd THEN ends := ends + 1; END_IF;`), async (sim) => {
    const pulseOn = async (name: string) => { await sim.set(name, true); await sim.scan(1, 10); await sim.set(name, false); await sim.scan(1, 10); };
    await sim.scan(1, 10);
    assert.equal(await sim.get('step'), 0);
    await pulseOn('start');
    assert.equal(await sim.get('step'), 1);
    // automatic: each true transition goes to the next step, the cycle restarts
    await sim.set('t', true);
    await sim.scan(3, 10);
    assert.equal(await sim.get('step'), 1, 'cycle 2 started');
    assert.equal(await sim.get('ends'), 1);
    // stop at the end of the cycle
    await sim.set('t', false);
    await pulseOn('stop');
    await sim.set('t', true);
    await sim.scan(3, 10);
    assert.equal(await sim.get('step'), 0);
    assert.equal(await sim.get('ends'), 2);
    await sim.scan(3, 10);
    assert.equal(await sim.get('step'), 0, 'stays in the initial step');
    // step by step: the transition waits for the validation
    await sim.set('mode', 3);
    await sim.set('t', false);
    await pulseOn('start');
    assert.equal(await sim.get('step'), 1);
    await sim.set('t', true);
    await sim.scan(5, 10);
    assert.equal(await sim.get('step'), 1);
    assert.equal(await sim.get('waiting'), true);
    await pulseOn('pulse');
    assert.equal(await sim.get('step'), 2);
    // hold (fault): frozen, even with a validation
    await sim.set('hold', true);
    await pulseOn('pulse');
    assert.equal(await sim.get('step'), 2);
    await sim.set('hold', false);
    await pulseOn('pulse');
    assert.equal(await sim.get('step'), 3);
    await pulseOn('pulse');
    assert.equal(await sim.get('step'), 0, 'end of cycle in step mode');
    // cycle by cycle
    await sim.set('mode', 2);
    await pulseOn('start');
    await sim.scan(5, 10);
    assert.equal(await sim.get('step'), 0);
    assert.equal(await sim.get('ends'), 4);
    // reset
    await pulseOn('start');
    await sim.set('t', false);
    await pulseOn('rst');
    assert.equal(await sim.get('step'), 0);
  });
});

test('stdlib: vision sensor trigger (OK, NG, timeout, not ready)', { skip }, async () => {
  await withSim(program(`
      exe : Bool; ready : Bool := TRUE; busy : Bool; valid : Bool; okBit : Bool; err : Bool;
      cam : "VPLC_VisionTrigger"; trig : Bool; running : Bool; ok : Bool; ng : Bool; fault : Bool; code : Int; done : Int;`, `
    cam(Execute := exe, Ready := ready, Busy := busy, ResultValid := valid, ResultOk := okBit, DeviceError := err, Timeout := T#300MS,
        TriggerOut => trig, Running => running, Ok => ok, Ng => ng, Error => fault, ErrorCode => code);
    IF cam.Done THEN done := done + 1; END_IF;`), async (sim) => {
    const inspect = async (result: boolean) => {
      await sim.set('exe', true);
      await sim.scan(1, 10);
      assert.equal(await sim.get('trig'), true);
      await sim.set('busy', true);
      await sim.scan(8, 10);
      await sim.set('busy', false);
      await sim.set('okBit', result);
      await sim.set('valid', true);
      await sim.scan(1, 10);
      await sim.set('exe', false);
      await sim.scan(1, 10);
      await sim.set('valid', false);
      await sim.scan(1, 10);
    };
    await inspect(true);
    assert.equal(await sim.get('ok'), true);
    assert.equal(await sim.get('trig'), false);
    await inspect(false);
    assert.equal(await sim.get('ng'), true);
    assert.equal(await sim.get('done'), 2);
    assert.equal(await sim.get('cam.NgCount'), 1);
    // no answer: timeout
    await sim.set('exe', true);
    await sim.scan(40, 10);
    assert.equal(await sim.get('fault'), true);
    assert.equal(await sim.get('code'), 2);
    await sim.set('exe', false);
    await sim.scan(1, 10);
    // not ready
    await sim.set('ready', false);
    await sim.set('exe', true);
    await sim.scan(1, 10);
    assert.equal(await sim.get('code'), 1);
    assert.equal(await sim.get('running'), false);
  });
});
