<?php

declare(strict_types=1);

namespace VirtualPLC\Scl;

/** Raised by the analyzer when a program is well-formed but invalid (unknown identifiers, duplicates, ...). */
final class SemanticError extends SclException
{
}
