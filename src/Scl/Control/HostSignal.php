<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Control;

/**
 * Base class for exceptions thrown by host (native) functions to unwind the
 * whole program, e.g. to reload or stop the runtime. The interpreter lets
 * them through untouched instead of wrapping them in a RuntimeError.
 */
abstract class HostSignal extends \Exception
{
}
