<?php

declare(strict_types=1);

namespace VirtualPLC\Tests\Http;

use PHPUnit\Framework\TestCase;
use VirtualPLC\Http\Api;
use VirtualPLC\Runtime\CommandQueue;
use VirtualPLC\Support\Config;

final class ApiTest extends TestCase
{
    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/vplc-api-' . bin2hex(random_bytes(4));
        mkdir($this->dir);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/{,.}*', GLOB_BRACE) ?: [] as $file) {
            if (is_file($file)) {
                unlink($file);
            }
        }
        foreach (glob($this->dir . '/backups/*') ?: [] as $file) {
            unlink($file);
        }
        @rmdir($this->dir . '/backups');
        rmdir($this->dir);
    }

    private function api(string $token = ''): Api
    {
        return new Api(new Config(dataDir: $this->dir, apiToken: $token));
    }

    /** @param array<string, string> $headers */
    private function post(Api $api, string $action, mixed $body, array $headers = []): \VirtualPLC\Http\Response
    {
        return $api->handle('POST', $action, $headers + ['content-type' => 'application/json'], (string) json_encode($body));
    }

    /** @return array<string, mixed> */
    private static function validProject(): array
    {
        return [
            'hardware' => [],
            'vars' => [['name' => 'Run', 'mode' => 'simple', 'type' => 'BOOL']],
            'db' => [['name' => 'Run', 'val' => 'TRUE']],
            'blocks' => [],
            'fc' => 'Run := NOT Run;',
        ];
    }

    public function testLoadReturnsAnEmptyProjectInitially(): void
    {
        $response = $this->api()->handle('GET', 'load', [], '');
        self::assertSame(200, $response->status);
        self::assertSame(['hardware' => [], 'vars' => [], 'db' => [], 'blocks' => [], 'fc' => ''], $response->decoded());
    }

    public function testSaveThenLoadRoundTrip(): void
    {
        $api = $this->api();
        $draft = ['vars' => [['name' => 'not valid yet!']]] + self::validProject();
        self::assertSame(200, $this->post($api, 'save', $draft)->status, 'drafts can be saved even if invalid');
        self::assertSame($draft['vars'], $api->handle('GET', 'load', [], '')->decoded()['vars']);
    }

    public function testDeployWritesTheProgram(): void
    {
        $response = $this->post($this->api(), 'deploy', self::validProject());
        self::assertSame(200, $response->status, $response->body);
        self::assertStringContainsString('Run : BOOL;', (string) file_get_contents($this->dir . '/project.scl'));
        self::assertFileExists($this->dir . '/project.json');
    }

    public function testRedeployKeepsABackup(): void
    {
        $api = $this->api();
        $this->post($api, 'deploy', self::validProject());
        $project = self::validProject();
        $project['fc'] = 'Run := TRUE;';
        $this->post($api, 'deploy', $project);
        self::assertCount(1, glob($this->dir . '/backups/project-*.scl') ?: []);
    }

    public function testDeployReportsBuildErrorsWithoutTouchingTheProgram(): void
    {
        $project = self::validProject();
        $project['fc'] = 'Nope := 1;';
        $response = $this->post($this->api(), 'deploy', $project);
        self::assertSame(422, $response->status);
        self::assertStringContainsString("undeclared variable 'Nope'", implode(' ', $response->decoded()['errors']));
        self::assertFileDoesNotExist($this->dir . '/project.scl');
    }

    public function testValidateDoesNotWriteAnything(): void
    {
        self::assertSame(200, $this->post($this->api(), 'validate', self::validProject())->status);
        self::assertFileDoesNotExist($this->dir . '/project.scl');
    }

    public function testTokenIsEnforced(): void
    {
        $api = $this->api('s3cret');
        self::assertSame(401, $api->handle('GET', 'load', [], '')->status);
        self::assertSame(401, $api->handle('GET', 'load', ['authorization' => 'Bearer wrong'], '')->status);
        self::assertSame(200, $api->handle('GET', 'load', ['authorization' => 'Bearer s3cret'], '')->status);
        self::assertSame(200, $api->handle('GET', 'load', ['x-api-token' => 's3cret'], '')->status);
        self::assertSame(200, $api->handle('GET', 'health', [], '')->status, 'health is public');
    }

    public function testRequestValidation(): void
    {
        $api = $this->api();
        self::assertSame(404, $api->handle('GET', 'nope', [], '')->status);
        self::assertSame(405, $api->handle('GET', 'deploy', [], '')->status);
        self::assertSame(415, $api->handle('POST', 'save', ['content-type' => 'text/plain'], '{}')->status, 'CSRF protection');
        self::assertSame(400, $api->handle('POST', 'save', ['content-type' => 'application/json'], '{bad')->status);
        self::assertSame(400, $this->post($api, 'save', ['vars' => 'x'])->status);
    }

    public function testStatusIsOfflineWithoutRuntime(): void
    {
        $status = $this->api()->handle('GET', 'status', [], '')->decoded();
        self::assertFalse($status['online']);
        self::assertSame('OFFLINE', $status['state']);
    }

    public function testStaleStatusIsReportedOffline(): void
    {
        file_put_contents($this->dir . '/status.json', json_encode(['state' => 'RUN', 'updated_at' => microtime(true) - 60]));
        self::assertFalse($this->api()->handle('GET', 'status', [], '')->decoded()['online']);
    }

    public function testWriteQueuesACommandWhenTheRuntimeIsOnline(): void
    {
        $api = $this->api();
        self::assertSame(503, $this->post($api, 'write', ['tag' => 'Run', 'value' => true])->status);

        file_put_contents($this->dir . '/status.json', json_encode(['state' => 'RUN', 'updated_at' => microtime(true)]));
        self::assertSame(202, $this->post($api, 'write', ['tag' => 'Run', 'value' => true])->status);
        self::assertSame(400, $this->post($api, 'write', ['tag' => 'Run', 'value' => 'x'])->status);
        self::assertSame(400, $this->post($api, 'write', ['tag' => 'a b', 'value' => 1])->status);

        $commands = (new CommandQueue($this->dir . '/commands.jsonl'))->drain();
        self::assertSame([['type' => 'write', 'tag' => 'Run', 'value' => true]], $commands);
    }
}
