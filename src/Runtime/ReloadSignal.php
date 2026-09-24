<?php

declare(strict_types=1);

namespace VirtualPLC\Runtime;

use VirtualPLC\Scl\Control\HostSignal;

/** The program file changed: the runtime must reload it. */
final class ReloadSignal extends HostSignal
{
}
