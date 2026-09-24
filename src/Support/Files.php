<?php

declare(strict_types=1);

namespace VirtualPLC\Support;

/** Filesystem helpers. */
final class Files
{
    /**
     * Writes a file atomically (temp file + rename) so that readers never
     * observe a partially written file.
     */
    public static function writeAtomic(string $path, string $contents, int $mode = 0664): void
    {
        $dir = dirname($path);
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new \RuntimeException("Cannot create directory {$dir}");
        }
        $tmp = @tempnam($dir, '.' . basename($path) . '.');
        if ($tmp === false) {
            throw new \RuntimeException("Cannot create a temporary file in {$dir} (check permissions)");
        }
        if (@file_put_contents($tmp, $contents) !== strlen($contents)) {
            @unlink($tmp);
            throw new \RuntimeException("Cannot write {$path} (disk full or permission denied)");
        }
        @chmod($tmp, $mode);
        if (!@rename($tmp, $path)) {
            @unlink($tmp);
            throw new \RuntimeException("Cannot replace {$path} (check permissions)");
        }
    }

    private function __construct()
    {
    }
}
