<?php

declare(strict_types=1);

namespace VirtualPLC\Tests\Modbus;

use PHPUnit\Framework\TestCase;
use VirtualPLC\Modbus\ModbusException;
use VirtualPLC\Modbus\ModbusTcpClient;

final class ModbusTcpClientTest extends TestCase
{
    public function testConnectionFailureRaisesModbusException(): void
    {
        // Grab a free port, then close it so nothing listens there.
        $probe = stream_socket_server('tcp://127.0.0.1:0');
        self::assertNotFalse($probe);
        $name = (string) stream_socket_get_name($probe, false);
        fclose($probe);
        $port = (int) substr($name, strrpos($name, ':') + 1);

        $client = new ModbusTcpClient('127.0.0.1', $port, 1, 0.2);
        $this->expectException(ModbusException::class);
        $client->readCoils(0, 1);
    }

    public function testRejectsInvalidQuantities(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        (new ModbusTcpClient('127.0.0.1'))->readHoldingRegisters(0, 200);
    }

    public function testRejectsInvalidConfiguration(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new ModbusTcpClient('127.0.0.1', 70000);
    }
}
