<?php

declare(strict_types=1);

namespace VirtualPLC\Modbus;

/** Communication failure or Modbus exception response. */
class ModbusException extends \RuntimeException
{
    public const ILLEGAL_FUNCTION = 0x01;
    public const ILLEGAL_DATA_ADDRESS = 0x02;
    public const ILLEGAL_DATA_VALUE = 0x03;
    public const SERVER_DEVICE_FAILURE = 0x04;

    private const NAMES = [
        0x01 => 'Illegal function',
        0x02 => 'Illegal data address',
        0x03 => 'Illegal data value',
        0x04 => 'Server device failure',
        0x05 => 'Acknowledge',
        0x06 => 'Server device busy',
        0x08 => 'Memory parity error',
        0x0A => 'Gateway path unavailable',
        0x0B => 'Gateway target device failed to respond',
    ];

    public static function fromExceptionCode(int $functionCode, int $exceptionCode): self
    {
        $name = self::NAMES[$exceptionCode] ?? 'Unknown exception';

        return new self(sprintf('Modbus exception 0x%02X (%s) for function 0x%02X', $exceptionCode, $name, $functionCode), $exceptionCode);
    }
}
