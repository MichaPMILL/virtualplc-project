<?php

declare(strict_types=1);

namespace VirtualPLC\Runtime;

use VirtualPLC\Scl\Control\HostSignal;

/** A shutdown was requested (SIGTERM/SIGINT). */
final class StopSignal extends HostSignal
{
}
