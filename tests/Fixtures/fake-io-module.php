<?php

/**
 * Simulated Modbus I/O module (8 coils, 8 discrete inputs) for integration tests.
 *
 * Usage: php fake-io-module.php <port> <inputs-file> <coils-file>
 * Inputs are read from <inputs-file> (JSON list of 8 booleans) on every poll,
 * coil states are written to <coils-file> (JSON list of 8 booleans).
 */

declare(strict_types=1);

use VirtualPLC\Modbus\ModbusTcpServer;
use VirtualPLC\Modbus\RegisterMap;
use VirtualPLC\Support\Logger;
use VirtualPLC\Tests\Fixtures\ArrayTagStore;

require dirname(__DIR__, 2) . '/vendor/autoload.php';

[$port, $inputsFile, $coilsFile] = [(int) ($argv[1] ?? 1502), $argv[2] ?? 'inputs.json', $argv[3] ?? 'coils.json'];

$store = new ArrayTagStore();
$coils = $inputs = [];
for ($i = 0; $i < 8; $i++) {
    $store->values["c{$i}"] = false;
    $store->values["i{$i}"] = false;
    $coils[$i] = "c{$i}";
    $inputs[$i] = "i{$i}";
}

$server = new ModbusTcpServer('127.0.0.1', $port, new Logger(Logger::WARNING));
$server->setRegisterMap(new RegisterMap($coils, $inputs));
$server->setTagStore($store);

while (true) {
    $inputs = is_file($inputsFile) ? json_decode((string) file_get_contents($inputsFile), true) : [];
    foreach (is_array($inputs) ? $inputs : [] as $i => $value) {
        $store->values["i{$i}"] = (bool) $value;
    }
    $server->poll(0.02);
    $coils = json_encode(array_map(static fn (int $i) => $store->values["c{$i}"], range(0, 7)));
    file_put_contents($coilsFile . '.tmp', $coils);
    rename($coilsFile . '.tmp', $coilsFile);
}
