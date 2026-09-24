<?php

declare(strict_types=1);

namespace VirtualPLC\Scl;

/** Raised while executing a program (division by zero, watchdog, ...). */
final class RuntimeError extends SclException
{
}
