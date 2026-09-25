// Conformance: programs compiled by the TypeScript compiler, executed by the C++ VM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { simAvailable, withSim } from './sim.ts';

const skip = simAvailable ? false : 'build runtime/ first (cmake -S runtime -B runtime/build && cmake --build runtime/build)';
const vmTest = (name: string, fn: () => Promise<void>) => test(name, { skip }, fn);
const approx = (actual: unknown, expected: number, eps = 1e-4) =>
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < eps, `${actual} ≈ ${expected}`);

vmTest('External source example: FB with timer, edge detection and instance DB', async () => {
  const source = readFileSync(new URL('../../examples/scl/motor.scl', import.meta.url), 'utf8');
  await withSim(source, async (sim) => {
    await sim.set('Stop_Button', true); // NC contact
    await sim.scan();
    assert.equal(await sim.get('Motor_Contactor'), false);
    assert.equal(await sim.get('Speed_Setpoint'), 1500, 'start value of a %MW tag');

    await sim.set('Start_Button', true);
    await sim.scan(1, 10);
    await sim.scan(1, 1980);
    assert.equal(await sim.get('Motor_Contactor'), false, 'start delay not elapsed');
    await sim.scan(1, 20);
    assert.equal(await sim.get('Motor_Contactor'), true);
    assert.equal(await sim.get('"Motor_DB".Running'), true);
    assert.equal(await sim.get('Starts'), 1, 'rising edge counted once');

    await sim.set('Stop_Button', false);
    await sim.scan();
    assert.equal(await sim.get('Motor_Contactor'), false);
  });
});

vmTest('arithmetic, typing and wrap-around', async () => {
  await withSim(`
    VAR_GLOBAL
      a : Int; b : Int; c : DInt; d : Real; e : LReal; f : Int; g : Word; h : Bool; i : Int; j : SInt; k : UInt;
    END_VAR
    ORGANIZATION_BLOCK "Main" BEGIN
      a := 2 + 3 * 4;
      b := 32767 + 1;          // INT wraps
      c := -7 / 2;             // truncation toward zero
      d := 7 / 2.0;
      e := 2.0 ** 10;
      f := 17 MOD 5;
      g := WORD#16#FF00 OR 16#0F;
      h := NOT (3 > 4) AND TRUE XOR FALSE;
      i := ABS(-5) + MIN(4, 2, 8) + MAX(1, 9) + LIMIT(0, 150, 100);
      j := 127 + 1;
      k := 65535 + 2;
    END_ORGANIZATION_BLOCK`, async (sim) => {
    await sim.scan();
    assert.equal(await sim.get('a'), 14);
    assert.equal(await sim.get('b'), -32768);
    assert.equal(await sim.get('c'), -3);
    assert.equal(await sim.get('d'), 3.5);
    assert.equal(await sim.get('e'), 1024);
    assert.equal(await sim.get('f'), 2);
    assert.equal(await sim.get('g'), 0xff0f);
    assert.equal(await sim.get('h'), true);
    assert.equal(await sim.get('i'), 5 + 2 + 9 + 100);
    assert.equal(await sim.get('j'), -128);
    assert.equal(await sim.get('k'), 1);
  });
});

vmTest('control flow: IF/ELSIF, CASE, FOR BY, WHILE with EXIT, REPEAT, CONTINUE', async () => {
  await withSim(`
    VAR_GLOBAL sum : Int; c : Int; n : Int; r : Int; evens : Int; sel : Int; out : Int; chain : Int; END_VAR
    ORGANIZATION_BLOCK "Main"
    VAR_TEMP i : Int; END_VAR
    BEGIN
      sum := 0; c := 0; n := 0; r := 0; evens := 0;
      FOR #i := 1 TO 10 DO sum := sum + #i; END_FOR;
      FOR #i := 10 TO 1 BY -3 DO c := c + 1; END_FOR;
      WHILE n < 5 DO n := n + 1; IF n = 3 THEN EXIT; END_IF; END_WHILE;
      REPEAT r := r + 2; UNTIL r >= 6 END_REPEAT;
      FOR #i := 1 TO 6 DO IF #i MOD 2 = 1 THEN CONTINUE; END_IF; evens += 1; END_FOR;
      CASE sel OF
        1, 2: out := 10;
        3..5: out := 20;
        -1: out := -1;
      ELSE out := 99;
      END_CASE;
      IF FALSE THEN chain := 1; ELSIF sel > 2 THEN chain := 2; ELSE chain := 3; END_IF;
    END_ORGANIZATION_BLOCK`, async (sim) => {
    await sim.scan();
    assert.equal(await sim.get('sum'), 55);
    assert.equal(await sim.get('c'), 4);
    assert.equal(await sim.get('n'), 3);
    assert.equal(await sim.get('r'), 6);
    assert.equal(await sim.get('evens'), 3);
    assert.equal(await sim.get('out'), 99);
    assert.equal(await sim.get('chain'), 3);
    for (const [sel, expected] of [[1, 10], [2, 10], [4, 20], [-1, -1], [7, 99]]) {
      await sim.set('sel', sel);
      await sim.scan();
      assert.equal(await sim.get('out'), expected, `CASE ${sel}`);
    }
  });
});

vmTest('timers TON / TOF / TP', async () => {
  await withSim(`
    VAR_GLOBAL In : Bool; OnDelay : Bool; OffDelay : Bool; Pulse : Bool; Et : Time; END_VAR
    DATA_BLOCK "T0" TON BEGIN END_DATA_BLOCK
    DATA_BLOCK "T1" TOF BEGIN END_DATA_BLOCK
    DATA_BLOCK "T2" TP BEGIN END_DATA_BLOCK
    ORGANIZATION_BLOCK "Main" BEGIN
      "T0"(IN := In, PT := T#1s, Q => OnDelay, ET => Et);
      "T1"(IN := In, PT := T#1s, Q => OffDelay);
      "T2"(IN := In, PT := T#500ms, Q => Pulse);
    END_ORGANIZATION_BLOCK`, async (sim) => {
    await sim.scan();
    assert.equal(await sim.get('OffDelay'), false, 'TOF is off until IN has been TRUE');
    await sim.set('In', true);
    await sim.scan(1, 10);
    assert.equal(await sim.get('OnDelay'), false);
    assert.equal(await sim.get('OffDelay'), true);
    assert.equal(await sim.get('Pulse'), true);
    await sim.scan(1, 600);
    assert.equal(await sim.get('Et'), 600);
    assert.equal(await sim.get('Pulse'), false, 'TP pulse lasts PT');
    await sim.scan(1, 400);
    assert.equal(await sim.get('OnDelay'), true);
    assert.equal(await sim.get('Et'), 1000, 'ET saturates at PT');
    await sim.set('In', false);
    await sim.scan(1, 10);
    assert.equal(await sim.get('OnDelay'), false);
    assert.equal(await sim.get('OffDelay'), true, 'TOF holds for PT');
    await sim.scan(1, 1000);
    assert.equal(await sim.get('OffDelay'), false);
  });
});

vmTest('counters and edge detection in a multi-instance FB', async () => {
  await withSim(`
    VAR_GLOBAL Pulse : Bool; Reset : Bool; Count : Int; Done : Bool; Falls : Int; Down : Int; END_VAR
    FUNCTION_BLOCK "Station"
    VAR C : CTU; D : CTD; F : F_TRIG; END_VAR
    BEGIN
      #C(CU := "Pulse", R := "Reset", PV := 3, Q => "Done", CV => "Count");
      #D(CD := "Pulse", LD := "Reset", PV := 5, CV => "Down");
      #F(CLK := "Pulse");
      IF #F.Q THEN "Falls" := "Falls" + 1; END_IF;
    END_FUNCTION_BLOCK
    DATA_BLOCK "Station_DB" "Station" BEGIN END_DATA_BLOCK
    ORGANIZATION_BLOCK "Main" BEGIN "Station_DB"(); END_ORGANIZATION_BLOCK`, async (sim) => {
    for (let k = 0; k < 3; k++) {
      await sim.set('Pulse', true);
      await sim.scan(2);
      await sim.set('Pulse', false);
      await sim.scan();
    }
    assert.equal(await sim.get('Count'), 3);
    assert.equal(await sim.get('Done'), true);
    assert.equal(await sim.get('Falls'), 3);
    assert.equal(await sim.get('Down'), -3);
    await sim.set('Reset', true);
    await sim.scan();
    assert.equal(await sim.get('Count'), 0);
    assert.equal(await sim.get('Down'), 5);
  });
});

vmTest('FC with return value, outputs, in-outs and string parameters', async () => {
  await withSim(`
    VAR_GLOBAL R : Real; Q : Int; Rem : Int; Acc : Int := 10; Msg : String[20]; Nested : Int; END_VAR
    FUNCTION "Average" : Real
    VAR_INPUT a : Real; b : Real; END_VAR
    BEGIN #Average := (#a + #b) / 2.0; END_FUNCTION
    FUNCTION "DivMod" : Void
    VAR_INPUT n : Int; d : Int; END_VAR
    VAR_OUTPUT quotient : Int; remainder : Int; END_VAR
    BEGIN #quotient := #n / #d; #remainder := #n MOD #d; END_FUNCTION
    FUNCTION "Add" : Void
    VAR_IN_OUT total : Int; END_VAR
    VAR_INPUT v : Int; END_VAR
    BEGIN #total := #total + #v; END_FUNCTION
    FUNCTION "Greet" : String
    VAR_INPUT who : String; END_VAR
    VAR_TEMP tmp : String; END_VAR
    BEGIN #tmp := 'Hello '; #Greet := CONCAT(#tmp, #who); END_FUNCTION
    FUNCTION "Twice" : Int
    VAR_INPUT x : Int; END_VAR
    BEGIN #Twice := #x * 2; END_FUNCTION
    ORGANIZATION_BLOCK "Main" BEGIN
      R := "Average"(a := 1.0, b := 2);
      "DivMod"(n := 17, d := 5, quotient => Q, remainder => Rem);
      "Add"(total := Acc, v := 5);
      Msg := "Greet"(who := 'PLC');
      Nested := "Twice"(x := "Twice"(x := 3) + 1);
    END_ORGANIZATION_BLOCK`, async (sim) => {
    await sim.scan();
    assert.equal(await sim.get('R'), 1.5);
    assert.equal(await sim.get('Q'), 3);
    assert.equal(await sim.get('Rem'), 2);
    assert.equal(await sim.get('Acc'), 15);
    assert.equal(await sim.get('Msg'), 'Hello PLC');
    assert.equal(await sim.get('Nested'), 14, 'nested call of the same FC');
  });
});

vmTest('REAL functions, scaling and conversions', async () => {
  await withSim(`
    VAR_GLOBAL Raw AT %IW64 : Int; Level : Real; Percent : Int; Text : String; Back : DInt; Root : Real; T : DInt; B : Bool; S : Real; END_VAR
    ORGANIZATION_BLOCK "Main" BEGIN
      Level := SCALE_X(MIN := 0.0, VALUE := NORM_X(MIN := 0, VALUE := Raw, MAX := 27648), MAX := 100.0);
      Percent := REAL_TO_INT(Level);
      Text := CONCAT('Level=', INT_TO_STRING(Percent), '%');
      Back := STRING_TO_DINT('-1234');
      Root := SQRT(16.0) + ROUND(2.5) + TRUNC(-3.7);
      T := REAL_TO_DINT(2.5) + REAL_TO_DINT(3.5);
      B := INT_TO_BOOL(Percent);
      S := SIN(0.0) + LN(1.0) + EXP(0.0);
    END_ORGANIZATION_BLOCK`, async (sim) => {
    await sim.set('Raw', 13824);
    await sim.scan();
    approx(await sim.get('Level'), 50);
    assert.equal(await sim.get('Percent'), 50);
    assert.equal(await sim.get('Text'), 'Level=50%');
    assert.equal(await sim.get('Back'), -1234);
    approx(await sim.get('Root'), 4 + 2 - 3);
    assert.equal(await sim.get('T'), 2 + 4, 'round half to even');
    assert.equal(await sim.get('B'), true);
    approx(await sim.get('S'), 1);
  });
});

vmTest('arrays, bounds check fault, and fault reporting with line number', async () => {
  await withSim(`
    VAR_GLOBAL Values : Array[1..5] of Int; Sum : Int; Idx : Int := 1; END_VAR
    ORGANIZATION_BLOCK "Main"
    VAR_TEMP i : Int; END_VAR
    BEGIN
      FOR #i := 1 TO 5 DO Values[#i] := #i * 10; END_FOR;
      Sum := 0;
      FOR #i := 1 TO 5 DO Sum += Values[#i]; END_FOR;
      Values[Idx] := 1;
    END_ORGANIZATION_BLOCK`, async (sim) => {
    await sim.scan();
    assert.deepEqual(await sim.get('Values'), [1, 20, 30, 40, 50]);
    assert.equal(await sim.get('Sum'), 150);
    await sim.set('Idx', 6);
    await sim.scan();
    const state = await sim.state();
    assert.equal(state.state, 'FAULT');
    assert.deepEqual({ ...(state.fault as object), pc: 0 }, { code: 'BOUNDS', function: 0, line: 9, pc: 0 });
    // Outputs are reset in FAULT, a cold restart recovers
    await sim.set('Idx', 1);
    await sim.ok('start cold');
    await sim.scan();
    assert.equal((await sim.state()).state, 'RUN');
  });
});

vmTest('division by zero puts the CPU in FAULT and outputs off', async () => {
  await withSim(`
    VAR_GLOBAL Lamp AT %Q0.0 : Bool; D : Int; X : Int; END_VAR
    ORGANIZATION_BLOCK "Main" BEGIN Lamp := TRUE; X := 10 / D; END_ORGANIZATION_BLOCK`, async (sim) => {
    await sim.scan();
    const state = await sim.state();
    assert.equal(state.state, 'FAULT');
    assert.equal((state.fault as { code: string }).code, 'DIV_ZERO');
    assert.equal(await sim.bit('Q', 0, 0), false, 'outputs are reset on fault');
  });
});

vmTest('process image: %I/%Q/%M, direct addresses, forces', async () => {
  await withSim(`
    DATA_BLOCK "Settings"
       VAR Threshold : Int := 10; Enabled : Bool; END_VAR
    BEGIN Enabled := TRUE; END_DATA_BLOCK
    ORGANIZATION_BLOCK "Main" BEGIN
      %M0.0 := "Settings".Enabled AND %MW2 > "Settings".Threshold;
      %QW4 := %MW2 * 2;
      %Q0.1 := %I0.3;
    END_ORGANIZATION_BLOCK`, async (sim) => {
    await sim.ok('write M 2 000b');
    await sim.bit('I', 0, 3, true);
    await sim.scan();
    assert.equal(await sim.bit('M', 0, 0), true);
    assert.equal(await sim.ok('read Q 4 2'), '0016');
    assert.equal(await sim.bit('Q', 0, 1), true);
    // Force the input to FALSE: the program sees the forced value
    await sim.ok('force I 0 3 0');
    await sim.scan();
    assert.equal(await sim.bit('Q', 0, 1), false);
    assert.equal((await sim.state()).forces, 1);
    // Force an output
    await sim.ok('force Q 0 1 1');
    await sim.scan();
    assert.equal(await sim.bit('Q', 0, 1), true);
  });
});

vmTest('startup OB runs once; historical sections work', async () => {
  await withSim(`
    VAR SystemOn : BOOL; Counter : INT; Boots : INT; END_VAR
    DB SystemOn := TRUE; Boots := Boots + 1; END_DB
    BLOCK Count
      IF SystemOn THEN Counter := Counter + 1; END_IF;
    END_BLOCK
    FC Count(); END_FC`, async (sim) => {
    await sim.scan(3);
    assert.equal(await sim.get('Boots'), 1);
    assert.equal(await sim.get('Counter'), 3);
  });
});

vmTest('historical WAIT loop suspends and resumes across scans', async () => {
  await withSim(`
    VAR Running : BOOL := TRUE; Ticks : INT; END_VAR
    FC
      WHILE Running DO
        Ticks := Ticks + 1;
        WAIT(100);
      END_WHILE;
    END_FC`, async (sim) => {
    await sim.scan(1, 10);
    assert.equal(await sim.get('Ticks'), 1);
    await sim.scan(5, 10); // 50 ms: still waiting
    assert.equal(await sim.get('Ticks'), 1);
    await sim.scan(5, 10);
    assert.equal(await sim.get('Ticks'), 2);
  });
});

vmTest('LOG messages are available through the protocol', async () => {
  await withSim(`
    VAR_GLOBAL n : Int := 41; r : Real := 1.5; END_VAR
    ORGANIZATION_BLOCK "Startup" BEGIN LOG('Answer=', n + 1, ' r=', r, ' ok=', TRUE); END_ORGANIZATION_BLOCK
    ORGANIZATION_BLOCK "Main" BEGIN END_ORGANIZATION_BLOCK`, async (sim) => {
    const logs = await sim.logs();
    assert.ok(logs.some((l) => l.msg === 'Answer=42 r=1.5 ok=TRUE'), JSON.stringify(logs));
  });
});

vmTest('watchdog stops an endless loop', async () => {
  await withSim(`
    VAR_GLOBAL x : DInt; END_VAR
    ORGANIZATION_BLOCK "Main" BEGIN WHILE TRUE DO x := x + 1; END_WHILE; END_ORGANIZATION_BLOCK`, async (sim) => {
    await sim.scan();
    const state = await sim.state();
    assert.equal(state.state, 'FAULT');
    assert.equal((state.fault as { code: string }).code, 'WATCHDOG');
  }, { watchdogMs: 50 });
});

vmTest('PLC data types (UDT) and anonymous structs', async () => {
  await withSim(`
    TYPE "Axis"
    VERSION : 0.1
      STRUCT
        Name : String[8] := 'X';
        Position : Real;
        Limits : Struct
          Low : Real := -10.0;
          High : Real := 10.0;
        END_STRUCT;
        Enabled : Bool := TRUE;
      END_STRUCT;
    END_TYPE

    TYPE "Cell"
      STRUCT
        Axes : Array[0..1] of "Axis";
        Count : Int;
      END_STRUCT;
    END_TYPE

    DATA_BLOCK "Machine"
      STRUCT
        Cell : "Cell";
        Saved : "Axis";
      END_STRUCT;
    BEGIN
    END_DATA_BLOCK

    FUNCTION "Clamp" : Real
      VAR_INPUT a : "Axis"; END_VAR
    BEGIN
      #Clamp := LIMIT(MN := #a.Limits.Low, IN := #a.Position, MX := #a.Limits.High);
    END_FUNCTION

    FUNCTION_BLOCK "Mover"
      VAR_INPUT target : "Axis"; END_VAR
      VAR_OUTPUT result : "Axis"; END_VAR
    BEGIN
      #result := #target;
      #result.Position := #target.Position * 2.0;
    END_FUNCTION_BLOCK

    VAR_GLOBAL
      Clamped : Real; Moved : Real; Copied : Real; Enabled : Bool; Low : Real; NameLen : Int; Temp : Real;
      M : "Mover";
    END_VAR

    ORGANIZATION_BLOCK "Main"
      VAR_TEMP t : "Axis"; END_VAR
    BEGIN
      "Machine".Cell.Axes[1].Position := 25.0;
      "Machine".Cell.Count += 1;
      Clamped := "Clamp"(a := "Machine".Cell.Axes[1]);
      "Machine".Saved := "Machine".Cell.Axes[1];
      Copied := "Machine".Saved.Position;
      M(target := "Machine".Saved, result => "Machine".Cell.Axes[0]);
      Moved := "Machine".Cell.Axes[0].Position;
      Enabled := "Machine".Cell.Axes[0].Enabled;
      Low := "Machine".Cell.Axes[0].Limits.Low;
      NameLen := LEN(#t.Name);
      #t.Position := 3.0;
      Temp := #t.Position;
    END_ORGANIZATION_BLOCK`, async (sim) => {
    await sim.scan();
    assert.equal(await sim.get('Clamped'), 10);
    assert.equal(await sim.get('Copied'), 25);
    assert.equal(await sim.get('Moved'), 50);
    assert.equal(await sim.get('Enabled'), true, 'start value inside a UDT');
    assert.equal(await sim.get('Low'), -10, 'start value inside a nested struct');
    assert.equal(await sim.get('NameLen'), 1, 'string start value of a temporary UDT');
    assert.equal(await sim.get('Temp'), 3);
    assert.equal(await sim.get('"Machine".Cell.Axes[1].Position'), 25);
    await sim.scan();
    assert.equal(await sim.get('"Machine".Cell.Count'), 2);
  });
});

vmTest('date, time and character types (Date, TOD, LTime, LTOD, DT, LDT, DTL, Char, LWord, ULInt)', async () => {
  // 2024-02-29 13:45:30.250 UTC
  // (the simulator advances its clock by one cycle, 10 ms, before the first scan)
  process.env.VPLC_SIM_CLOCK_NS = String((Date.UTC(2024, 1, 29, 13, 45, 30, 250) - 10) * 1_000_000);
  try {
    await withSim(`
      VAR_GLOBAL
        Day : Date := D#2024-02-29;
        Start : Time_Of_Day := TOD#23:30:00;
        Later : TOD;
        Span : Time;
        Long : LTime := LT#1d2h3m4s5ms6us7ns;
        LongFromTime : LTime;
        Clock : LTOD := LTOD#12:00:00.000000001;
        Stamp : LDT := LDT#2024-01-15-08:00:00.5;
        Old : Date_And_Time := DT#2024-01-15-08:00:00.500;
        Now : DTL;
        NowLdt : LDT;
        NowDt : DT;
        NowDate : Date;
        NowTod : TOD;
        Elapsed : LTime;
        Fixed : DTL := DTL#2000-12-31-23:59:59.0;
        Letter : Char := 'A';
        Next : Char;
        Wide : WChar := WCHAR#'é';
        Text : String;
        FirstChar : Char;
        Mask : LWord := LWORD#16#FFFF_0000_FFFF_0000;
        Big : ULInt := 12345678901234;
        Msg : WString := WSTRING#'Hello';
        IsLetter : Bool;
        Status : Int;
      END_VAR
      ORGANIZATION_BLOCK "Main" BEGIN
        Later := Start + T#1H;                 // wraps around midnight
        Span := Later - TOD#00:00:00;
        LongFromTime := TIME_TO_LTIME(T#2S);
        Status := RD_SYS_T(OUT => Now);
        Status := RD_SYS_T(OUT => NowLdt);
        Status := RD_SYS_T(OUT => NowDt);
        NowDate := LDT_TO_DATE(NowLdt);
        NowTod := DTL_TO_TOD(Now);
        Elapsed := NowLdt - Stamp;
        Next := INT_TO_CHAR(CHAR_TO_INT(Letter) + 1);
        Text := CONCAT(IN1 := CHAR_TO_STRING(Letter), IN2 := CHAR_TO_STRING(Next));
        FirstChar := STRING_TO_CHAR('xyz');
        IsLetter := Letter >= 'A' AND Letter <= 'Z';
      END_ORGANIZATION_BLOCK`, async (sim) => {
      await sim.scan();
      const days = (y: number, m: number, d: number) => (Date.UTC(y, m - 1, d) - Date.UTC(1990, 0, 1)) / 86_400_000;
      assert.equal(await sim.get('Day'), days(2024, 2, 29));
      assert.equal(await sim.get('Later'), 30 * 60_000, 'TOD + TIME wraps at midnight');
      assert.equal(await sim.get('Span'), 30 * 60_000);
      assert.equal(await sim.get('Long'), ((((1 * 24 + 2) * 60 + 3) * 60 + 4) * 1000 + 5) * 1e6 + 6007);
      assert.equal(await sim.get('LongFromTime'), 2e9);
      assert.equal(await sim.get('Now.YEAR'), 2024);
      assert.equal(await sim.get('Now.MONTH'), 2);
      assert.equal(await sim.get('Now.DAY'), 29);
      assert.equal(await sim.get('Now.WEEKDAY'), 5, 'Thursday (1 = Sunday)');
      assert.equal(await sim.get('Now.HOUR'), 13);
      assert.equal(await sim.get('Now.SECOND'), 30);
      assert.equal(await sim.get('Now.NANOSECOND'), 250_000_000);
      assert.equal(await sim.get('NowDate'), days(2024, 2, 29));
      assert.equal(await sim.get('NowTod'), ((13 * 60 + 45) * 60 + 30) * 1000 + 250);
      assert.equal(await sim.get('Elapsed'), Number(BigInt(Date.UTC(2024, 1, 29, 13, 45, 30, 250)) * 1_000_000n - (BigInt(Date.UTC(2024, 0, 15, 8)) * 1_000_000n + 500_000_000n)));
      assert.equal(await sim.get('Fixed.YEAR'), 2000);
      assert.equal(await sim.get('Fixed.MINUTE'), 59);
      assert.equal(await sim.get('Letter'), 65);
      assert.equal(await sim.get('Next'), 66);
      assert.equal(await sim.get('Wide'), 0xe9);
      assert.equal(await sim.get('Text'), 'AB');
      assert.equal(await sim.get('FirstChar'), 'x'.charCodeAt(0));
      assert.equal(await sim.get('IsLetter'), true);
      assert.equal(await sim.get('Big'), 12345678901234);
      assert.equal(await sim.get('Mask'), 0xffff0000ffff0000n);
      assert.equal(await sim.get('Msg'), 'Hello');
      assert.equal(await sim.get('Status'), 0);
    });
  } finally {
    delete process.env.VPLC_SIM_CLOCK_NS;
  }
});

vmTest('64-bit integer literals stay exact (LWord, ULInt, LInt)', async () => {
  await withSim(`
    VAR_GLOBAL CONSTANT
      K : LWord := 16#0102_0304_0506_0708;
      KBig : ULInt := 9_007_199_254_740_993 * 2;
    END_VAR
    VAR_GLOBAL
      L : LWord := 16#0102030405060708;
      AllOnes : LWord := 16#FFFF_FFFF_FFFF_FFFF;
      Oct : LWord := 8#1777777777777777777777;
      Bin : LWord := 2#1000000000000000000000000000000000000000000000000000000000000001;
      UMax : ULInt := 18446744073709551615;
      UNear : ULInt := 18_446_744_073_709_551_614;
      LMin : LInt := -9223372036854775808;
      LMax : LInt := 9223372036854775807;
      Folded : LInt := 9007199254740993 + 2;
      FoldedMin : LInt := -9223372036854775807 - 1;
      Inverted : LWord := NOT 16#0102030405060708;
      Typed : LWord := LWORD#16#0102030405060708;
      TypedNeg : LInt := LINT#-9223372036854775808;
      Low : DWord;
      High : DWord;
      E1 : LWord;
      E2 : ULInt;
      E3 : LInt;
      E4 : LWord;
      E5 : LWord;
      E6 : ULInt;
      Same : Bool;
      Differs : Bool;
    END_VAR
    ORGANIZATION_BLOCK "Main" BEGIN
      Low := LWORD_TO_DWORD(L);
      High := LWORD_TO_DWORD(SHR(IN := L, N := 32));
      E1 := LWORD#16#0102030405060708;
      E2 := ULINT#18446744073709551615;
      E3 := LINT#-9223372036854775808;
      E4 := L XOR 16#FFFF_FFFF_FFFF_FFFF;
      E5 := K;
      E6 := KBig;
      Same := L = 16#0102030405060708;
      Differs := L <> 16#0102030405060709;
    END_ORGANIZATION_BLOCK`, async (sim) => {
    await sim.scan();
    assert.equal(await sim.get('L'), 0x0102030405060708n);
    assert.equal(await sim.get('Low'), 0x05060708);
    assert.equal(await sim.get('High'), 0x01020304);
    assert.equal(await sim.get('AllOnes'), 0xffffffffffffffffn);
    assert.equal(await sim.get('Oct'), 0xffffffffffffffffn);
    assert.equal(await sim.get('Bin'), 0x8000000000000001n);
    assert.equal(await sim.get('UMax'), 18446744073709551615n);
    assert.equal(await sim.get('UNear'), 18446744073709551614n);
    assert.equal(await sim.get('LMin'), -9223372036854775808n);
    assert.equal(await sim.get('LMax'), 9223372036854775807n);
    assert.equal(await sim.get('Folded'), 9007199254740995n);
    assert.equal(await sim.get('FoldedMin'), -9223372036854775808n);
    assert.equal(await sim.get('Inverted'), 0xfefdfcfbfaf9f8f7n);
    assert.equal(await sim.get('Typed'), 0x0102030405060708n);
    assert.equal(await sim.get('TypedNeg'), -9223372036854775808n);
    assert.equal(await sim.get('E1'), 0x0102030405060708n);
    assert.equal(await sim.get('E2'), 18446744073709551615n);
    assert.equal(await sim.get('E3'), -9223372036854775808n);
    assert.equal(await sim.get('E4'), 0xfefdfcfbfaf9f8f7n);
    assert.equal(await sim.get('E5'), 0x0102030405060708n);
    assert.equal(await sim.get('E6'), 18014398509481986n);
    assert.equal(await sim.get('Same'), true);
    assert.equal(await sim.get('Differs'), true);
  });
});
