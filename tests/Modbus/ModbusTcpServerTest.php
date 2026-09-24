<?php

declare(strict_types=1);

namespace VirtualPLC\Tests\Modbus;

use PHPUnit\Framework\TestCase;
use VirtualPLC\Modbus\ModbusTcpServer;
use VirtualPLC\Modbus\RegisterMap;
use VirtualPLC\Support\Logger;
use VirtualPLC\Tests\Fixtures\ArrayTagStore;

final class ModbusTcpServerTest extends TestCase
{
    private ModbusTcpServer $server;
    private ArrayTagStore $store;

    protected function setUp(): void
    {
        $this->server = new ModbusTcpServer('127.0.0.1', 0, new Logger(Logger::ERROR + 1));
        $this->store = new ArrayTagStore(['Run' => true, 'Lamp' => false, 'Button' => true, 'Speed' => -2]);
        $this->server->setRegisterMap(new RegisterMap(
            coils: [0 => 'Run', 1 => 'Lamp'],
            discreteInputs: [2 => 'Button'],
            holdingRegisters: [3 => 'Speed'],
            inputRegisters: [3 => 'Speed'],
            names: ['Run', 'Lamp', 'Button', 'Speed'],
        ));
        $this->server->setTagStore($this->store);
    }

    protected function tearDown(): void
    {
        $this->server->close();
    }

    public function testReadCoils(): void
    {
        self::assertSame("\x01\x01\x01", $this->server->handlePdu("\x01\x00\x00\x00\x03"));
    }

    public function testReadDiscreteInputs(): void
    {
        self::assertSame("\x02\x01\x04", $this->server->handlePdu("\x02\x00\x00\x00\x03"));
    }

    public function testReadHoldingRegistersEncodesNegativeValues(): void
    {
        self::assertSame("\x03\x04\x00\x00\xFF\xFE", $this->server->handlePdu("\x03\x00\x02\x00\x02"));
    }

    public function testWriteSingleCoil(): void
    {
        self::assertSame("\x05\x00\x01\xFF\x00", $this->server->handlePdu("\x05\x00\x01\xFF\x00"));
        self::assertTrue($this->store->values['Lamp']);
    }

    public function testWriteSingleRegisterIsSigned(): void
    {
        $this->server->handlePdu("\x06\x00\x03\xFF\xF6");
        self::assertSame(-10, $this->store->values['Speed']);
    }

    public function testWriteMultipleCoils(): void
    {
        self::assertSame("\x0F\x00\x00\x00\x02", $this->server->handlePdu("\x0F\x00\x00\x00\x02\x01\x02"));
        self::assertFalse($this->store->values['Run']);
        self::assertTrue($this->store->values['Lamp']);
    }

    public function testWriteMultipleRegisters(): void
    {
        self::assertSame("\x10\x00\x03\x00\x01", $this->server->handlePdu("\x10\x00\x03\x00\x01\x02\x00\x2A"));
        self::assertSame(42, $this->store->values['Speed']);
    }

    public function testNameDiscovery(): void
    {
        // Variable #3 ("Speed") starts at 1000 + 3 * 10
        $response = $this->server->handlePdu("\x04" . pack('nn', 1030, 3));
        self::assertSame("\x04\x06Speed\x00", $response);
    }

    public function testExceptionResponses(): void
    {
        self::assertSame("\x81\x03", $this->server->handlePdu("\x01\x00\x00\x00\x00"), 'quantity 0');
        self::assertSame("\x83\x03", $this->server->handlePdu("\x03\x00\x00\x00\x7E"), 'too many registers');
        self::assertSame("\x82\x02", $this->server->handlePdu("\x02\xFF\xFF\x00\x02"), 'address overflow');
        self::assertSame("\x85\x03", $this->server->handlePdu("\x05\x00\x00\x12\x34"), 'invalid coil value');
        self::assertSame("\x96\x01", $this->server->handlePdu("\x16\x00\x00"), 'unsupported function');
        self::assertSame("\x8F\x03", $this->server->handlePdu("\x0F\x00\x00\x00\x09\x01\x00"), 'byte count mismatch');
    }

    public function testDeviceFailureWhenNoProgramIsRunning(): void
    {
        $this->server->setTagStore(null);
        self::assertSame("\x81\x04", $this->server->handlePdu("\x01\x00\x00\x00\x01"));
    }

    public function testServesFragmentedAndPipelinedFramesOverTcp(): void
    {
        $client = stream_socket_client('tcp://127.0.0.1:' . $this->server->localPort(), $errno, $errstr, 1.0);
        self::assertNotFalse($client);
        $this->server->poll(0.1); // accept

        $frame1 = pack('nnnC', 1, 0, 6, 1) . "\x01\x00\x00\x00\x02";
        $frame2 = pack('nnnC', 2, 0, 6, 1) . "\x03\x00\x03\x00\x01";
        fwrite($client, substr($frame1, 0, 4));
        $this->server->poll(0.1);
        fwrite($client, substr($frame1, 4) . $frame2);
        $this->server->poll(0.1);

        stream_set_timeout($client, 1);
        $expected = pack('nnnC', 1, 0, 4, 1) . "\x01\x01\x01" . pack('nnnC', 2, 0, 5, 1) . "\x03\x02\xFF\xFE";
        self::assertSame($expected, fread($client, 1024));
        fclose($client);
    }
}
