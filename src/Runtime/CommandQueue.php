<?php

declare(strict_types=1);

namespace VirtualPLC\Runtime;

/**
 * File-based queue used by the web API to send commands (e.g. "write tag")
 * to the runtime process. One JSON object per line, protected by flock().
 */
final class CommandQueue
{
    private const MAX_PENDING_BYTES = 1_048_576;

    public function __construct(private readonly string $path)
    {
    }

    /** @param array<string, mixed> $command */
    public function push(array $command): void
    {
        $handle = @fopen($this->path, 'c');
        if ($handle === false) {
            throw new \RuntimeException("Cannot open command queue {$this->path}");
        }
        try {
            flock($handle, LOCK_EX);
            if (fstat($handle)['size'] > self::MAX_PENDING_BYTES) {
                throw new \RuntimeException('Command queue is full (is the runtime running?)');
            }
            fseek($handle, 0, SEEK_END);
            fwrite($handle, json_encode($command, JSON_THROW_ON_ERROR) . "\n");
            fflush($handle);
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }
    }

    /** @return list<array<string, mixed>> commands in submission order; the queue is emptied */
    public function drain(): array
    {
        clearstatcache(true, $this->path);
        if (!is_file($this->path) || filesize($this->path) === 0) {
            return [];
        }
        $handle = @fopen($this->path, 'r+');
        if ($handle === false) {
            return [];
        }
        try {
            flock($handle, LOCK_EX);
            $contents = stream_get_contents($handle);
            ftruncate($handle, 0);
            fflush($handle);
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }

        $commands = [];
        foreach (explode("\n", (string) $contents) as $line) {
            if (trim($line) === '') {
                continue;
            }
            $decoded = json_decode($line, true);
            if (is_array($decoded)) {
                $commands[] = $decoded;
            }
        }

        return $commands;
    }
}
