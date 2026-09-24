<?php

declare(strict_types=1);

namespace VirtualPLC\Modbus;

/** Modbus public function codes supported by the client and the server. */
final class FunctionCode
{
    public const READ_COILS = 0x01;
    public const READ_DISCRETE_INPUTS = 0x02;
    public const READ_HOLDING_REGISTERS = 0x03;
    public const READ_INPUT_REGISTERS = 0x04;
    public const WRITE_SINGLE_COIL = 0x05;
    public const WRITE_SINGLE_REGISTER = 0x06;
    public const WRITE_MULTIPLE_COILS = 0x0F;
    public const WRITE_MULTIPLE_REGISTERS = 0x10;

    /** Protocol limits (Modbus Application Protocol v1.1b3). */
    public const MAX_READ_BITS = 2000;
    public const MAX_READ_REGISTERS = 125;
    public const MAX_WRITE_BITS = 1968;
    public const MAX_WRITE_REGISTERS = 123;

    private function __construct()
    {
    }
}
