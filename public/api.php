<?php

declare(strict_types=1);

use VirtualPLC\Http\Api;
use VirtualPLC\Support\Config;

require dirname(__DIR__) . '/vendor/autoload.php';

$headers = [];
foreach ($_SERVER as $key => $value) {
    if (str_starts_with($key, 'HTTP_')) {
        $headers[strtolower(str_replace('_', '-', substr($key, 5)))] = (string) $value;
    }
}
// Some SAPIs expose these without the HTTP_ prefix.
foreach (['CONTENT_TYPE' => 'content-type', 'REDIRECT_HTTP_AUTHORIZATION' => 'authorization'] as $key => $name) {
    if (isset($_SERVER[$key]) && !isset($headers[$name])) {
        $headers[$name] = (string) $_SERVER[$key];
    }
}

$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$action = is_string($_GET['action'] ?? null) ? $_GET['action'] : '';
$body = $method === 'POST' ? (string) file_get_contents('php://input', false, null, 0, Api::MAX_BODY_BYTES + 1) : '';

try {
    $response = (new Api(Config::fromEnvironment()))->handle($method, $action, $headers, $body);
} catch (\Throwable $e) {
    error_log('[virtualplc] ' . $e);
    $response = \VirtualPLC\Http\Response::error(500, 'Server misconfiguration');
}

http_response_code($response->status);
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');
foreach ($response->headers as $name => $value) {
    header("{$name}: {$value}");
}
echo $response->body;
