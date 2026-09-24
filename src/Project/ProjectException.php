<?php

declare(strict_types=1);

namespace VirtualPLC\Project;

/** A project failed validation or compilation. Carries every error found. */
final class ProjectException extends \RuntimeException
{
    /** @param list<string> $errors */
    public function __construct(public readonly array $errors)
    {
        parent::__construct(implode("\n", $errors));
    }
}
