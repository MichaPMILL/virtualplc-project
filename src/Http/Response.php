<?php

declare(strict_types=1);

namespace VirtualPLC\Http;

final class Response
{
    /** @param array<string, string> $headers */
    public function __construct(
        public readonly int $status,
        public readonly string $body,
        public readonly array $headers = [],
    ) {
    }

    /** @param array<string, string> $headers */
    public static function json(mixed $payload, int $status = 200, array $headers = []): self
    {
        $body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);

        return new self($status, $body === false ? '{}' : $body, ['Content-Type' => 'application/json; charset=utf-8'] + $headers);
    }

    /** @param array<string, string> $headers */
    public static function error(int $status, string $message, array $headers = []): self
    {
        return self::json(['status' => 'error', 'error' => $message], $status, $headers);
    }

    public function decoded(): mixed
    {
        return json_decode($this->body, true);
    }
}
