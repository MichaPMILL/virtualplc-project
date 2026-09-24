<?php

declare(strict_types=1);

namespace VirtualPLC\Scl;

use VirtualPLC\Scl\Ast\Address;

/**
 * Process image of the PLC: inputs (%I), outputs (%Q) and bit memory (%M),
 * 64 KiB each. Multi-byte values are big-endian, as on most PLCs.
 */
final class ProcessImage
{
    public const AREA_SIZE = 65536;

    /** @var array{I: array<int, int>, Q: array<int, int>, M: array<int, int>} sparse byte storage */
    private array $bytes = ['I' => [], 'Q' => [], 'M' => []];

    public function read(Address $address, ?string $type = null): bool|int|float
    {
        $type ??= $address->defaultType();
        $this->check($address);
        $area = $address->area;

        return match ($address->size) {
            'X' => $this->getBit($area, $address->byte, $address->bit),
            'B' => self::signed($this->getByte($area, $address->byte), 8, $type === 'SINT'),
            'W' => self::signed($this->getUnsigned($area, $address->byte, 2), 16, $type === 'INT'),
            default => match ($type) {
                'REAL' => unpack('G', pack('N', $this->getUnsigned($area, $address->byte, 4)))[1],
                'DINT', 'TIME' => self::signed($this->getUnsigned($area, $address->byte, 4), 32, true),
                default => $this->getUnsigned($area, $address->byte, 4),
            },
        };
    }

    public function write(Address $address, bool|int|float $value, ?string $type = null): void
    {
        $type ??= $address->defaultType();
        $this->check($address);
        $area = $address->area;

        match ($address->size) {
            'X' => $this->setBit($area, $address->byte, $address->bit, (bool) $value),
            'B' => $this->setUnsigned($area, $address->byte, 1, (int) $value),
            'W' => $this->setUnsigned($area, $address->byte, 2, (int) $value),
            default => $type === 'REAL'
                ? $this->setUnsigned($area, $address->byte, 4, unpack('N', pack('G', (float) $value))[1])
                : $this->setUnsigned($area, $address->byte, 4, (int) $value),
        };
    }

    public function getBit(string $area, int $byte, int $bit): bool
    {
        return (($this->bytes[$area][$byte] ?? 0) >> $bit & 1) === 1;
    }

    public function setBit(string $area, int $byte, int $bit, bool $value): void
    {
        $current = $this->bytes[$area][$byte] ?? 0;
        $this->storeByte($area, $byte, $value ? $current | (1 << $bit) : $current & ~(1 << $bit));
    }

    public function getByte(string $area, int $byte): int
    {
        return $this->bytes[$area][$byte] ?? 0;
    }

    public function setByte(string $area, int $byte, int $value): void
    {
        $this->storeByte($area, $byte, $value & 0xFF);
    }

    /** Non-zero bytes of an area (for diagnostics). @return array<int, int> */
    public function area(string $area): array
    {
        $bytes = $this->bytes[$area];
        ksort($bytes);

        return $bytes;
    }

    public function clear(string $area): void
    {
        $this->bytes[$area] = [];
    }

    private function getUnsigned(string $area, int $byte, int $length): int
    {
        $value = 0;
        for ($i = 0; $i < $length; $i++) {
            $value = ($value << 8) | ($this->bytes[$area][$byte + $i] ?? 0);
        }

        return $value;
    }

    private function setUnsigned(string $area, int $byte, int $length, int $value): void
    {
        for ($i = $length - 1; $i >= 0; $i--) {
            $this->storeByte($area, $byte + $i, $value & 0xFF);
            $value >>= 8;
        }
    }

    private function storeByte(string $area, int $byte, int $value): void
    {
        if ($value === 0) {
            unset($this->bytes[$area][$byte]);
        } else {
            $this->bytes[$area][$byte] = $value;
        }
    }

    private function check(Address $address): void
    {
        $length = match ($address->size) {
            'X', 'B' => 1,
            'W' => 2,
            default => 4,
        };
        if ($address->byte + $length > self::AREA_SIZE) {
            throw new RuntimeError("Address {$address} is out of the process image");
        }
    }

    private static function signed(int $value, int $bits, bool $signed): int
    {
        return $signed && $value >= (1 << ($bits - 1)) ? $value - (1 << $bits) : $value;
    }
}
