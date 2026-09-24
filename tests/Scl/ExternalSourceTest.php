<?php

declare(strict_types=1);

namespace VirtualPLC\Tests\Scl;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use VirtualPLC\Scl\Ast\Address;
use VirtualPLC\Scl\Interpreter;
use VirtualPLC\Scl\Parser;
use VirtualPLC\Scl\RuntimeError;
use VirtualPLC\Scl\SemanticError;
use VirtualPLC\Scl\SyntaxError;

/**
 * Programs written as "external source" SCL files.
 */
final class ExternalSourceTest extends TestCase
{
    private int $now = 0;

    private function interpreter(string $source): Interpreter
    {
        $interpreter = new Interpreter();
        $interpreter->setClock(fn (): int => $this->now);
        $interpreter->load(Parser::parseSource($source));
        $interpreter->start();

        return $interpreter;
    }

    private function setInput(Interpreter $plc, string $address, bool|int $value): void
    {
        $plc->image()->write(Address::parse($address) ?? throw new \LogicException($address), $value);
    }

    private function readImage(Interpreter $plc, string $address): bool|int|float
    {
        return $plc->image()->read(Address::parse($address) ?? throw new \LogicException($address));
    }

    private const MOTOR = <<<'SCL'
        VAR_GLOBAL
            "Start_Button" AT %I0.0 : Bool;
            "Stop_Button" AT %I0.1 : Bool;   // NC contact
            "Motor_Contactor" AT %Q0.0 : Bool;
            "Speed_Setpoint" AT %MW10 : Int := 1500;
            "Starts" : DInt;
        END_VAR

        FUNCTION_BLOCK "Motor"
        { Attribute := 'TRUE' }
        VERSION : 0.1
           VAR_INPUT
              Start : Bool;
              Stop : Bool;
              StartDelay : Time := T#2S;
           END_VAR
           VAR_OUTPUT
              Running : Bool;
           END_VAR
           VAR
              DelayTimer : TON;
              StartEdge : R_TRIG;
              Requested : Bool;
           END_VAR

        BEGIN
            REGION Start / stop logic
                #StartEdge(CLK := #Start);
                IF #StartEdge.Q THEN
                    #Requested := TRUE;
                    "Starts" += 1;
                END_IF;
                IF NOT #Stop THEN
                    #Requested := FALSE;
                END_IF;
            END_REGION

            #DelayTimer(IN := #Requested, PT := #StartDelay);
            #Running := #DelayTimer.Q;
        END_FUNCTION_BLOCK

        DATA_BLOCK "Motor_DB"
        { Attribute := 'TRUE' }
        VERSION : 0.1
        NON_RETAIN
        "Motor"

        BEGIN

        END_DATA_BLOCK

        ORGANIZATION_BLOCK "Main"
        TITLE = "Main Program Sweep (Cycle)"
        { Attribute := 'TRUE' }
        VERSION : 0.1

        BEGIN
            "Motor_DB"(Start := "Start_Button",
                       Stop := "Stop_Button",
                       Running => "Motor_Contactor");
        END_ORGANIZATION_BLOCK
        SCL;

    public function testExternalSourceWithFunctionBlockAndTimer(): void
    {
        $plc = $this->interpreter(self::MOTOR);
        $this->setInput($plc, '%I0.1', true); // stop button not pressed (NC)
        $plc->scan();
        self::assertFalse($this->readImage($plc, '%Q0.0'));
        self::assertSame(1500, $plc->readTag('"Speed_Setpoint"'));

        $this->setInput($plc, '%I0.0', true);
        $plc->scan();
        $this->now = 1999;
        $plc->scan();
        self::assertFalse($this->readImage($plc, '%Q0.0'), 'start delay not elapsed');
        self::assertSame(1999, $plc->readTag('Motor_DB.DelayTimer.ET'));

        $this->now = 2000;
        $plc->scan();
        self::assertTrue($this->readImage($plc, '%Q0.0'));
        self::assertTrue($plc->readTag('"Motor_DB".Running'));
        self::assertSame(1, $plc->readTag('Starts'), 'rising edge counted once');

        $this->setInput($plc, '%I0.1', false); // stop pressed
        $plc->scan();
        self::assertFalse($this->readImage($plc, '%Q0.0'));
    }

    public function testMemoryExportsTagsAndDataBlocks(): void
    {
        $memory = $this->interpreter(self::MOTOR)->memory();
        self::assertSame(1500, $memory['Speed_Setpoint']);
        self::assertFalse($memory['Motor_DB']['Running']);
        self::assertArrayNotHasKey('_start', $memory['Motor_DB']['DelayTimer'], 'hidden state is not exported');
    }

    public function testTimersTofAndTp(): void
    {
        $plc = $this->interpreter(<<<'SCL'
            VAR_GLOBAL In : Bool; OffDelay : Bool; Pulse : Bool; END_VAR
            DATA_BLOCK "T1" TOF BEGIN END_DATA_BLOCK
            DATA_BLOCK "T2" TP BEGIN END_DATA_BLOCK
            ORGANIZATION_BLOCK "Main"
            BEGIN
                "T1"(IN := In, PT := T#1s, Q => OffDelay);
                "T2"(IN := In, PT := T#500ms, Q => Pulse);
            END_ORGANIZATION_BLOCK
            SCL);
        $plc->scan();
        self::assertFalse($plc->readTag('OffDelay'), 'TOF is off until IN has been TRUE');

        $plc->writeTag('In', true);
        $plc->scan();
        self::assertTrue($plc->readTag('OffDelay'));
        self::assertTrue($plc->readTag('Pulse'));

        $this->now = 600;
        $plc->writeTag('In', false);
        $plc->scan();
        self::assertTrue($plc->readTag('OffDelay'), 'TOF holds for PT after IN falls');
        self::assertFalse($plc->readTag('Pulse'), 'TP pulse lasts PT');

        $this->now = 1600;
        $plc->scan();
        self::assertFalse($plc->readTag('OffDelay'));
    }

    public function testCountersAndEdges(): void
    {
        $plc = $this->interpreter(<<<'SCL'
            VAR_GLOBAL Pulse : Bool; Reset : Bool; Count : Int; Done : Bool; Falls : Int; END_VAR
            FUNCTION_BLOCK "Station"
            VAR C : CTU; F : F_TRIG; END_VAR
            BEGIN
                #C(CU := "Pulse", R := "Reset", PV := 3, Q => "Done", CV => "Count");
                #F(CLK := "Pulse");
                IF #F.Q THEN "Falls" := "Falls" + 1; END_IF;
            END_FUNCTION_BLOCK
            DATA_BLOCK "Station_DB" "Station" BEGIN END_DATA_BLOCK
            ORGANIZATION_BLOCK "Main" BEGIN "Station_DB"(); END_ORGANIZATION_BLOCK
            SCL);
        for ($i = 0; $i < 3; $i++) {
            $plc->writeTag('Pulse', true);
            $plc->scan();
            $plc->scan();
            $plc->writeTag('Pulse', false);
            $plc->scan();
        }
        self::assertSame(3, $plc->readTag('Count'));
        self::assertTrue($plc->readTag('Done'));
        self::assertSame(3, $plc->readTag('Falls'));

        $plc->writeTag('Reset', true);
        $plc->scan();
        self::assertSame(0, $plc->readTag('Count'));
    }

    public function testFunctionWithReturnValueAndOutputs(): void
    {
        $plc = $this->interpreter(<<<'SCL'
            VAR_GLOBAL R : Real; Q : Int; Rem : Int; END_VAR
            FUNCTION "Average" : Real
            VAR_INPUT a : Real; b : Real; END_VAR
            BEGIN
                #Average := (#a + #b) / 2.0;
            END_FUNCTION
            FUNCTION "DivMod" : Void
            VAR_INPUT n : Int; d : Int; END_VAR
            VAR_OUTPUT quotient : Int; remainder : Int; END_VAR
            BEGIN
                #quotient := #n / #d;
                #remainder := #n MOD #d;
            END_FUNCTION
            ORGANIZATION_BLOCK "Main"
            BEGIN
                "R" := "Average"(a := 1.0, b := 2);
                "DivMod"(n := 17, d := 5, quotient => "Q", remainder => "Rem");
            END_ORGANIZATION_BLOCK
            SCL);
        $plc->scan();
        self::assertSame(1.5, $plc->readTag('R'));
        self::assertSame(3, $plc->readTag('Q'));
        self::assertSame(2, $plc->readTag('Rem'));
    }

    public function testRealArithmeticAndConversions(): void
    {
        $plc = $this->interpreter(<<<'SCL'
            VAR_GLOBAL
                Raw AT %IW64 : Int;
                Level : Real;
                Percent : Int;
                Text : String;
                Big : DInt;
            END_VAR
            ORGANIZATION_BLOCK "Main"
            BEGIN
                "Level" := SCALE_X(MIN := 0.0, VALUE := NORM_X(MIN := 0, VALUE := "Raw", MAX := 27648), MAX := 100.0);
                "Percent" := REAL_TO_INT("Level");
                "Text" := CONCAT('Level=', INT_TO_STRING("Percent"), '%');
                "Big" := 100000 * 3;
            END_ORGANIZATION_BLOCK
            SCL);
        $plc->image()->write(Address::parse('%IW64'), 13824, 'INT');
        $plc->scan();
        self::assertEqualsWithDelta(50.0, $plc->readTag('Level'), 0.001);
        self::assertSame(50, $plc->readTag('Percent'));
        self::assertSame('Level=50%', $plc->readTag('Text'));
        self::assertSame(300000, $plc->readTag('Big'));
    }

    public function testImplicitNarrowingIsRejected(): void
    {
        $plc = $this->interpreter('VAR_GLOBAL i : Int; END_VAR ORGANIZATION_BLOCK "Main" BEGIN i := 2.5; END_ORGANIZATION_BLOCK');
        $this->expectException(RuntimeError::class);
        $this->expectExceptionMessage('use REAL_TO_INT()');
        $plc->scan();
    }

    public function testArraysLoopsAndCompoundAssignments(): void
    {
        $plc = $this->interpreter(<<<'SCL'
            VAR_GLOBAL Values : Array[1..5] of Int; Sum : Int; Evens : Int; END_VAR
            ORGANIZATION_BLOCK "Main"
            VAR_TEMP i : Int; END_VAR
            BEGIN
                FOR #i := 1 TO 5 DO
                    "Values"[#i] := #i * 10;
                END_FOR;
                "Sum" := 0;
                FOR #i := 1 TO 5 DO
                    IF #i MOD 2 = 1 THEN CONTINUE; END_IF;
                    "Evens" += 1;
                    "Sum" += "Values"[#i];
                END_FOR;
            END_ORGANIZATION_BLOCK
            SCL);
        $plc->scan();
        self::assertSame([10, 20, 30, 40, 50], $plc->readTag('Values'));
        self::assertSame(60, $plc->readTag('Sum'));
        self::assertSame(2, $plc->readTag('Evens'));
        self::assertSame(30, $plc->readTag('Values[3]'));

        $plc->writeTag('Values[2]', 7);
        self::assertSame(7, $plc->readTag('"Values"[2]'));
    }

    public function testArrayBoundsAreChecked(): void
    {
        $plc = $this->interpreter('VAR_GLOBAL a : Array[0..2] of Bool; i : Int := 3; END_VAR ORGANIZATION_BLOCK "Main" BEGIN a[i] := TRUE; END_ORGANIZATION_BLOCK');
        $this->expectExceptionMessage('Array index 3 out of bounds [0..2]');
        $plc->scan();
    }

    public function testDirectAddressesAndGlobalDataBlock(): void
    {
        $plc = $this->interpreter(<<<'SCL'
            DATA_BLOCK "Settings"
            VERSION : 0.1
            NON_RETAIN
               VAR
                  Threshold : Int := 10;
                  Enabled : Bool;
               END_VAR
            BEGIN
               Enabled := TRUE;
            END_DATA_BLOCK

            ORGANIZATION_BLOCK "Main"
            BEGIN
                %M0.0 := "Settings".Enabled AND %MW2 > "Settings".Threshold;
                %QW4 := %MW2 * 2;
            END_ORGANIZATION_BLOCK
            SCL);
        $plc->writeTag('%MW2', 11);
        $plc->scan();
        self::assertTrue($plc->readTag('%M0.0'));
        self::assertSame(22, $plc->readTag('%QW4'));
        self::assertSame(['Threshold' => 10, 'Enabled' => true], $plc->readTag('Settings'));
    }

    public function testStartupOrganizationBlockRunsOnce(): void
    {
        $plc = $this->interpreter(<<<'SCL'
            VAR_GLOBAL Boots : Int; Scans : Int; END_VAR
            ORGANIZATION_BLOCK "Startup" BEGIN "Boots" += 1; END_ORGANIZATION_BLOCK
            ORGANIZATION_BLOCK "Main" BEGIN "Scans" += 1; END_ORGANIZATION_BLOCK
            SCL);
        $plc->scan();
        $plc->scan();
        self::assertSame(1, $plc->readTag('Boots'));
        self::assertSame(2, $plc->readTag('Scans'));
    }

    public function testMultiInstanceKeepsStateBetweenScans(): void
    {
        $plc = $this->interpreter(<<<'SCL'
            VAR_GLOBAL Total : Int; END_VAR
            FUNCTION_BLOCK "Acc"
            VAR_INPUT Add : Int; END_VAR
            VAR_OUTPUT Value : Int; END_VAR
            BEGIN #Value := #Value + #Add; END_FUNCTION_BLOCK
            FUNCTION_BLOCK "Line"
            VAR A : "Acc"; B : "Acc"; END_VAR
            VAR_OUTPUT Sum : Int; END_VAR
            BEGIN
                #A(Add := 1);
                #B(Add := 10);
                #Sum := #A.Value + #B.Value;
            END_FUNCTION_BLOCK
            DATA_BLOCK "Line_DB" "Line" BEGIN END_DATA_BLOCK
            ORGANIZATION_BLOCK "Main" BEGIN "Line_DB"(Sum => "Total"); END_ORGANIZATION_BLOCK
            SCL);
        $plc->scan();
        $plc->scan();
        self::assertSame(22, $plc->readTag('Total'));
        self::assertSame(2, $plc->readTag('Line_DB.A.Value'));
    }

    #[DataProvider('literals')]
    public function testTypedLiterals(string $literal, string $type, int|float|bool $expected): void
    {
        $plc = $this->interpreter("VAR_GLOBAL x : {$type}; END_VAR ORGANIZATION_BLOCK \"Main\" BEGIN x := {$literal}; END_ORGANIZATION_BLOCK");
        $plc->scan();
        self::assertSame($expected, $plc->readTag('x'));
    }

    /** @return iterable<array{string, string, int|float|bool}> */
    public static function literals(): iterable
    {
        yield ['T#1h2m3s4ms', 'Time', 3_723_004];
        yield ['T#1.5s', 'Time', 1500];
        yield ['TIME#-250ms', 'Time', -250];
        yield ['WORD#16#FFFF', 'Word', 65535];
        yield ['INT#-5', 'Int', -5];
        yield ['1.0E3', 'Real', 1000.0];
        yield ['BOOL#TRUE', 'Bool', true];
        yield ['40000', 'Int', 40000 - 65536];
        yield ['2#1111_0000', 'Byte', 240];
    }

    #[DataProvider('semanticErrors')]
    public function testSemanticErrors(string $source, string $message): void
    {
        try {
            (new Interpreter())->load(Parser::parseSource($source));
            self::fail('SemanticError expected');
        } catch (SemanticError $e) {
            self::assertStringContainsString($message, $e->getMessage());
        }
    }

    /** @return iterable<array{string, string}> */
    public static function semanticErrors(): iterable
    {
        yield 'unknown local' => ['FUNCTION_BLOCK "F" BEGIN #nope := 1; END_FUNCTION_BLOCK', "in the interface of 'F'"];
        yield 'unknown global' => ['ORGANIZATION_BLOCK "Main" BEGIN "Nope" := 1; END_ORGANIZATION_BLOCK', 'in the tag table'];
        yield 'write to %I' => ['ORGANIZATION_BLOCK "Main" BEGIN %I0.0 := TRUE; END_ORGANIZATION_BLOCK', 'Cannot assign to input %I0.0'];
        yield 'write to input tag' => ['VAR_GLOBAL b AT %I0.0 : Bool; END_VAR ORGANIZATION_BLOCK "Main" BEGIN b := TRUE; END_ORGANIZATION_BLOCK', "Cannot assign to input 'b'"];
        yield 'address/type mismatch' => ['VAR_GLOBAL b AT %MW0 : Bool; END_VAR', 'does not fit address %MW0'];
        yield 'unknown type' => ['VAR_GLOBAL b : Motor; END_VAR', "Unknown data type 'Motor'"];
        yield 'FB called directly' => ['FUNCTION_BLOCK "F" END_FUNCTION_BLOCK ORGANIZATION_BLOCK "Main" BEGIN "F"(); END_ORGANIZATION_BLOCK', 'must be called through an instance'];
        yield 'timer called directly' => ['ORGANIZATION_BLOCK "Main" BEGIN TON(IN := TRUE, PT := T#1s); END_ORGANIZATION_BLOCK', 'must be called through an instance'];
        yield 'unknown FB parameter' => ['VAR_GLOBAL t : TON; END_VAR ORGANIZATION_BLOCK "Main" BEGIN t(IN := TRUE, PX := T#1s); END_ORGANIZATION_BLOCK', "'TON' has no parameter 'PX'"];
        yield 'input used as output' => ['VAR_GLOBAL t : TON; b : Bool; END_VAR ORGANIZATION_BLOCK "Main" BEGIN t(IN => b); END_ORGANIZATION_BLOCK', "use ':=' instead of '=>'"];
        yield 'unknown member' => ['VAR_GLOBAL t : TON; b : Bool; END_VAR ORGANIZATION_BLOCK "Main" BEGIN b := t.Done; END_ORGANIZATION_BLOCK', "'TON' has no member 'Done'"];
        yield 'constant write' => ['FUNCTION "F" : Void VAR CONSTANT K : Int := 1; END_VAR BEGIN #K := 2; END_FUNCTION', "Cannot assign to constant 'K'"];
        yield 'instance DB of FC' => ['FUNCTION "F" : Void BEGIN END_FUNCTION DATA_BLOCK "D" "F" BEGIN END_DATA_BLOCK', 'is not a function block'];
        yield 'FB instance in FC' => ['FUNCTION "F" : Void VAR t : TON; END_VAR BEGIN END_FUNCTION', 'must be declared in a FUNCTION_BLOCK'];
    }

    public function testSyntaxErrorsOnInvalidLiterals(): void
    {
        $this->expectException(SyntaxError::class);
        $this->expectExceptionMessage("Invalid time literal 'T#5x'");
        Parser::parseSource('ORGANIZATION_BLOCK "Main" BEGIN "t" := T#5x; END_ORGANIZATION_BLOCK');
    }
}
