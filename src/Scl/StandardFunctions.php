<?php

declare(strict_types=1);

namespace VirtualPLC\Scl;

use VirtualPLC\Scl\Ast\TypeRef;

/**
 * IEC 61131-3 standard functions available to every program:
 * math, selection, scaling, bit shifts, strings and type conversions (*_TO_*).
 */
final class StandardFunctions
{
    public static function register(Interpreter $interpreter): void
    {
        $num = static function (mixed $v): int|float {
            if (is_bool($v)) {
                return (int) $v;
            }
            if (!is_int($v) && !is_float($v)) {
                throw new \InvalidArgumentException('numeric argument expected');
            }

            return $v;
        };
        $real = static fn (mixed $v): float => (float) $num($v);

        $interpreter->registerFunction('ABS', static fn (mixed $IN): int|float => abs($num($IN)));
        $interpreter->registerFunction('MIN', static fn (mixed ...$IN): int|float => min(array_map($num, $IN ?: throw new \ArgumentCountError())));
        $interpreter->registerFunction('MAX', static fn (mixed ...$IN): int|float => max(array_map($num, $IN ?: throw new \ArgumentCountError())));
        $interpreter->registerFunction('LIMIT', static fn (mixed $MN, mixed $IN, mixed $MX): int|float => max($num($MN), min($num($IN), $num($MX))));
        $interpreter->registerFunction('SEL', static fn (mixed $G, mixed $IN0, mixed $IN1): mixed => $G ? $IN1 : $IN0);
        $interpreter->registerFunction('MUX', static function (mixed $K, mixed ...$IN): mixed {
            $k = (int) $K;
            if (!array_key_exists($k, $IN)) {
                throw new \InvalidArgumentException("selector {$k} out of range");
            }

            return $IN[$k];
        });

        $interpreter->registerFunction('SQRT', static fn (mixed $IN): float => $real($IN) < 0 ? throw new \InvalidArgumentException('negative argument') : sqrt($real($IN)));
        $interpreter->registerFunction('SQR', static fn (mixed $IN): int|float => $num($IN) * $num($IN));
        $interpreter->registerFunction('EXP', static fn (mixed $IN): float => exp($real($IN)));
        $interpreter->registerFunction('LN', static fn (mixed $IN): float => $real($IN) <= 0 ? throw new \InvalidArgumentException('argument must be > 0') : log($real($IN)));
        $interpreter->registerFunction('EXPT', static fn (mixed $IN1, mixed $IN2): float => $real($IN1) ** $real($IN2));
        $interpreter->registerFunction('SIN', static fn (mixed $IN): float => sin($real($IN)));
        $interpreter->registerFunction('COS', static fn (mixed $IN): float => cos($real($IN)));
        $interpreter->registerFunction('TAN', static fn (mixed $IN): float => tan($real($IN)));
        $interpreter->registerFunction('ASIN', static fn (mixed $IN): float => asin($real($IN)));
        $interpreter->registerFunction('ACOS', static fn (mixed $IN): float => acos($real($IN)));
        $interpreter->registerFunction('ATAN', static fn (mixed $IN): float => atan($real($IN)));
        $interpreter->registerFunction('TRUNC', static fn (mixed $IN): int => self::wrap((int) $real($IN), 32, true));
        $interpreter->registerFunction('ROUND', static fn (mixed $IN): float => round($real($IN), 0, PHP_ROUND_HALF_EVEN));
        $interpreter->registerFunction('CEIL', static fn (mixed $IN): int => (int) ceil($real($IN)));
        $interpreter->registerFunction('FLOOR', static fn (mixed $IN): int => (int) floor($real($IN)));
        $interpreter->registerFunction('FRAC', static fn (mixed $IN): float => $real($IN) - (int) $real($IN));

        // Analog value handling
        $interpreter->registerFunction('NORM_X', static function (mixed $MIN, mixed $VALUE, mixed $MAX) use ($real): float {
            $range = $real($MAX) - $real($MIN);

            return $range == 0 ? 0.0 : ($real($VALUE) - $real($MIN)) / $range;
        });
        $interpreter->registerFunction('SCALE_X', static fn (mixed $MIN, mixed $VALUE, mixed $MAX): float => $real($VALUE) * ($real($MAX) - $real($MIN)) + $real($MIN));

        // Bit shifts
        $interpreter->registerFunction('SHL', static fn (mixed $IN, mixed $N): int => ((int) $IN << (int) $N) & 0xFFFFFFFF);
        $interpreter->registerFunction('SHR', static fn (mixed $IN, mixed $N): int => ((int) $IN & 0xFFFFFFFF) >> (int) $N);

        // Strings
        $interpreter->registerFunction('CONCAT', static fn (mixed ...$IN): string => implode('', array_map(static fn ($v) => is_bool($v) ? ($v ? 'TRUE' : 'FALSE') : (string) $v, $IN)));
        $interpreter->registerFunction('LEN', static fn (mixed $IN): int => strlen((string) $IN));
    }

    /** Wraps an integer to the range of a $bits-wide (un)signed type. */
    public static function wrap(int $value, int $bits, bool $signed): int
    {
        if ($bits >= 64) {
            return $value;
        }
        $mask = (1 << $bits) - 1;
        $value &= $mask;

        return $signed && $value >= (1 << ($bits - 1)) ? $value - (1 << $bits) : $value;
    }

    /**
     * Recognises conversion function names like REAL_TO_INT or INT_TO_STRING.
     *
     * @return array{0: string, 1: string}|null source and target type
     */
    public static function conversion(string $name): ?array
    {
        if (preg_match('/^([A-Z]+)_TO_([A-Z]+)$/', strtoupper($name), $m) !== 1) {
            return null;
        }
        if (!isset(TypeRef::ELEMENTARY[$m[1]], TypeRef::ELEMENTARY[$m[2]])) {
            return null;
        }

        return [$m[1], $m[2]];
    }

    public static function convert(mixed $value, string $from, string $to, int $line): mixed
    {
        $class = TypeRef::ELEMENTARY[$to];
        if (is_string($value) && $class !== 'string') {
            $trimmed = trim($value);
            if (!is_numeric($trimmed) && !in_array(strtoupper($trimmed), ['TRUE', 'FALSE'], true)) {
                throw new RuntimeError("{$from}_TO_{$to}: '{$value}' is not a number", $line);
            }
            $value = match (strtoupper($trimmed)) {
                'TRUE' => true,
                'FALSE' => false,
                default => str_contains($trimmed, '.') || stripos($trimmed, 'e') !== false ? (float) $trimmed : (int) $trimmed,
            };
        }

        return match ($class) {
            'bool' => is_float($value) ? $value != 0.0 : (bool) $value,
            'float' => (float) $value,
            'string' => match (true) {
                is_bool($value) => $value ? 'TRUE' : 'FALSE',
                is_float($value) => rtrim(rtrim(sprintf('%.6F', $value), '0'), '.') ?: '0',
                default => (string) $value,
            },
            default => self::wrap(
                is_float($value) ? (int) round($value, 0, PHP_ROUND_HALF_EVEN) : (int) $value,
                ...TypeRef::INTEGER_RANGES[$to],
            ),
        };
    }

    private function __construct()
    {
    }
}
