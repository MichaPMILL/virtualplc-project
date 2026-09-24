<?php

declare(strict_types=1);

namespace VirtualPLC\Http;

use VirtualPLC\Project\ProjectCompiler;
use VirtualPLC\Project\ProjectException;
use VirtualPLC\Runtime\CommandQueue;
use VirtualPLC\Support\Config;
use VirtualPLC\Support\Files;
use VirtualPLC\Version;

/**
 * JSON API used by the web IDE.
 *
 *   GET  ?action=health    liveness probe (no authentication)
 *   GET  ?action=load      current project
 *   POST ?action=save      save the project (drafts allowed, not deployed)
 *   POST ?action=validate  compile without deploying, returns errors
 *   POST ?action=deploy    validate, save and hand the program to the runtime
 *   GET  ?action=status    runtime state, variables and diagnostics
 *   POST ?action=write     write a tag value (applied at the next scan)
 *
 * Mutating requests must use Content-Type: application/json, which prevents
 * cross-site form submissions (CSRF). When VPLC_API_TOKEN is set, every call
 * except health requires "Authorization: Bearer <token>".
 */
final class Api
{
    public const MAX_BODY_BYTES = 2_097_152;
    private const BACKUPS_KEPT = 20;
    /** The runtime publishes its status every 200 ms; older than this means it is not running. */
    private const STATUS_STALE_AFTER = 3.0;

    private const ROUTES = [
        'health' => ['GET', false],
        'load' => ['GET', true],
        'save' => ['POST', true],
        'validate' => ['POST', true],
        'deploy' => ['POST', true],
        'status' => ['GET', true],
        'write' => ['POST', true],
    ];

    public function __construct(
        private readonly Config $config,
        private readonly ProjectCompiler $compiler = new ProjectCompiler(),
    ) {
    }

    /** @param array<string, string> $headers lower-case header names */
    public function handle(string $method, string $action, array $headers, string $body): Response
    {
        try {
            $route = self::ROUTES[$action] ?? null;
            if ($route === null) {
                return Response::error(404, 'Unknown action');
            }
            [$allowedMethod, $needsAuth] = $route;
            if ($method !== $allowedMethod) {
                return Response::error(405, "Method {$method} not allowed", ['Allow' => $allowedMethod]);
            }
            if ($needsAuth && !$this->authorized($headers)) {
                return Response::error(401, 'Authentication required', ['WWW-Authenticate' => 'Bearer']);
            }

            $input = null;
            if ($method === 'POST') {
                if (!str_starts_with(strtolower($headers['content-type'] ?? ''), 'application/json')) {
                    return Response::error(415, 'Content-Type must be application/json');
                }
                if (strlen($body) > self::MAX_BODY_BYTES) {
                    return Response::error(413, 'Request body too large');
                }
                try {
                    $input = json_decode($body, true, 64, JSON_THROW_ON_ERROR);
                } catch (\JsonException $e) {
                    return Response::error(400, 'Invalid JSON: ' . $e->getMessage());
                }
            }

            return match ($action) {
                'health' => Response::json(['status' => 'ok', 'version' => Version::VERSION]),
                'load' => $this->load(),
                'save' => $this->save($input),
                'validate' => $this->validate($input),
                'deploy' => $this->deploy($input),
                'status' => $this->status(),
                'write' => $this->write($input),
            };
        } catch (\Throwable $e) {
            error_log('[virtualplc] API error: ' . $e);

            return Response::error(500, $e instanceof \RuntimeException ? $e->getMessage() : 'Internal server error');
        }
    }

    /** @param array<string, string> $headers */
    private function authorized(array $headers): bool
    {
        if ($this->config->apiToken === '') {
            return true;
        }
        $provided = $headers['x-api-token'] ?? '';
        if (preg_match('/^Bearer\s+(\S+)$/i', $headers['authorization'] ?? '', $m) === 1) {
            $provided = $m[1];
        }

        return $provided !== '' && hash_equals($this->config->apiToken, $provided);
    }

    private function load(): Response
    {
        $file = $this->config->projectFile();
        if (!is_file($file)) {
            return Response::json(['hardware' => [], 'vars' => [], 'db' => [], 'blocks' => [], 'fc' => '']);
        }
        $project = json_decode((string) file_get_contents($file), true);
        if (!is_array($project)) {
            return Response::error(500, 'Stored project is corrupted');
        }

        return Response::json($project);
    }

    private function save(mixed $input): Response
    {
        if (!is_array($input) || array_is_list($input) && $input !== []) {
            return Response::error(400, 'Project must be a JSON object');
        }
        $project = [];
        foreach (['hardware' => [], 'vars' => [], 'db' => [], 'blocks' => [], 'fc' => ''] as $key => $default) {
            $value = $input[$key] ?? $default;
            if (gettype($value) !== gettype($default)) {
                return Response::error(400, "'{$key}' has an invalid type");
            }
            $project[$key] = $value;
        }
        $this->storeProject($project);

        return Response::json(['status' => 'success', 'message' => 'Project saved.']);
    }

    private function validate(mixed $input): Response
    {
        try {
            $this->compiler->compile($input);
        } catch (ProjectException $e) {
            return Response::json(['status' => 'error', 'error' => 'Validation failed', 'errors' => $e->errors], 422);
        }

        return Response::json(['status' => 'success', 'message' => 'Project is valid.']);
    }

    private function deploy(mixed $input): Response
    {
        try {
            $project = $this->compiler->normalize($input);
            $compiled = $this->compiler->compile($project);
        } catch (ProjectException $e) {
            return Response::json(['status' => 'error', 'error' => 'Build failed', 'errors' => $e->errors], 422);
        }

        $this->storeProject($project);
        $this->backup($compiled->source);
        // Writing the program file is what triggers the runtime to reload.
        Files::writeAtomic($this->config->programFile(), $compiled->source);

        return Response::json([
            'status' => 'success',
            'message' => 'Deployed. The runtime reloads the program within a second.',
            'runtime_online' => $this->readStatus()['online'],
        ]);
    }

    private function status(): Response
    {
        return Response::json($this->readStatus());
    }

    private function write(mixed $input): Response
    {
        if (!is_array($input)) {
            return Response::error(400, 'Expected {"tag": "...", "value": ...}');
        }
        $tag = $input['tag'] ?? null;
        $value = $input['value'] ?? null;
        if (!is_string($tag) || preg_match('/^[A-Za-z_]\w{0,63}$/', $tag) !== 1) {
            return Response::error(400, 'Invalid tag name');
        }
        if (!is_bool($value) && !is_int($value)) {
            return Response::error(400, 'Value must be a boolean or an integer');
        }
        if (!$this->readStatus()['online']) {
            return Response::error(503, 'Runtime is not running');
        }

        (new CommandQueue($this->config->commandFile()))->push(['type' => 'write', 'tag' => $tag, 'value' => $value]);

        return Response::json(['status' => 'success', 'message' => "Write to {$tag} queued."], 202);
    }

    /** @return array<string, mixed> */
    private function readStatus(): array
    {
        $file = $this->config->statusFile();
        $status = is_file($file) ? json_decode((string) @file_get_contents($file), true) : null;
        if (!is_array($status)) {
            return ['state' => 'OFFLINE', 'online' => false, 'variables' => new \stdClass()];
        }

        $age = microtime(true) - (float) ($status['updated_at'] ?? 0);
        $status['age_s'] = round($age, 2);
        $status['online'] = $age < self::STATUS_STALE_AFTER && ($status['state'] ?? '') !== 'STOPPED';
        if (!$status['online']) {
            $status['state'] = 'OFFLINE';
        }

        return $status;
    }

    /** @param array<string, mixed> $project */
    private function storeProject(array $project): void
    {
        Files::writeAtomic(
            $this->config->projectFile(),
            json_encode($project, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
        );
    }

    /** Keeps the last deployed programs so that a bad deployment can be rolled back. */
    private function backup(string $source): void
    {
        $dir = $this->config->dataDir . '/backups';
        $current = $this->config->programFile();
        if (!is_file($current) || @file_get_contents($current) === $source) {
            return;
        }
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            return;
        }
        @copy($current, sprintf('%s/project-%s.scl', $dir, gmdate('Ymd-His')));

        $backups = glob($dir . '/project-*.scl') ?: [];
        sort($backups);
        foreach (array_slice($backups, 0, max(0, count($backups) - self::BACKUPS_KEPT)) as $old) {
            @unlink($old);
        }
    }
}
