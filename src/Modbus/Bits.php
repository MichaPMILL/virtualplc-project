<?php

declare(strict_types=1);

namespace VirtualPLC\Modbus;

/** @internal Packing helpers for Modbus bit fields (LSB first). */
final class Bits
{
    /**
     * @param list<bool> $bits
     */
    public static function pack(array $bits): string
    {
        $bytes = array_fill(0, (int) ceil(count($bits) / 8), 0);
        foreach ($bits as $i => $bit) {
            if ($bit) {
                $bytes[intdiv($i, 8)] |= 1 << ($i % 8);
            }
        }

        return pack('C*', ...$bytes);
    }

    /** @return list<bool> */
    public static function unpack(string $data, int $count): array
    {
        $bits = [];
        for ($i = 0; $i < $count; $i++) {
            $byte = intdiv($i, 8);
            $bits[] = $byte < strlen($data) && (ord($data[$byte]) & (1 << ($i % 8))) !== 0;
        }

        return $bits;
    }

    private function __construct()
    {
    }
}
