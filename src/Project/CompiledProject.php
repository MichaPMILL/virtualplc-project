<?php

declare(strict_types=1);

namespace VirtualPLC\Project;

use VirtualPLC\Scl\SclException;

/** Generated SCL source plus the information needed to map errors back to user blocks. */
final class CompiledProject
{
    /**
     * @param list<array{label: string, start: int, end: int}> $segments line ranges of user-written code
     */
    public function __construct(
        public readonly string $source,
        public readonly array $segments,
    ) {
    }

    /** Human-readable error message, pointing into the block the user edited when possible. */
    public function describeError(SclException $e): string
    {
        $line = $e->sourceLine;
        if ($line !== null) {
            foreach ($this->segments as $segment) {
                if ($line === $segment['end'] + 1) {
                    // Error on the generated END_xxx line: the user code is incomplete.
                    return ucfirst("{$segment['label']}: unexpected end of code ({$e->getRawMessage()}) - missing END_IF, END_WHILE, ...?");
                }
                if ($line >= $segment['start'] && $line <= $segment['end']) {
                    $local = $line - $segment['start'] + 1;
                    $column = $e->sourceColumn === null ? '' : ", column {$e->sourceColumn}";

                    return ucfirst("{$segment['label']}, line {$local}{$column}: {$e->getRawMessage()}");
                }
            }

            return "Generated program, line {$line}: {$e->getRawMessage()}";
        }

        return $e->getRawMessage();
    }
}
