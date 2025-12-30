<?php
// daemon.php
$baseDir = __DIR__;
$sclFile = $baseDir . '/project.scl';
$statusFile = $baseDir . '/status.json';

require_once $baseDir . '/SCLCore.php';
require_once $baseDir . '/ModbusRelayController.php';
require_once $baseDir . '/ModbusServer.php';

class ReloadSignal extends Exception {}

$lastMapHash = '';

// 1. Start Modbus Server (Listening on Port 5020)
$server = new ModbusServer(5020, []);

echo "[SYSTEM] Daemon Started. Watching: $sclFile\n";

$lastMod = 0;
if (file_exists($sclFile)) $lastMod = filemtime($sclFile);

while (true) {
    $connections = [];
    $interpreter = new Interpreter();

    $serverMemory = []; 
    $interpreter->memory = &$serverMemory;

    // 2. Hardware Handler (SCL -> Modbus Extender)
    $interpreter->setHardwareHandler(function($act, $h, $io, $addr, $val=null) use (&$connections) {
        if(!isset($connections[$h])) return null;
        try {
            if($act==='WRITE' && $io==='OUTPUT') $connections[$h]->setRelay($addr, $val?'on':'off');
            if($act==='READ') {
                if($io==='INPUT') { $r=$connections[$h]->readInputStatus(0,8); return $r[$addr]??false; }
                if($io==='OUTPUT') { $r=$connections[$h]->readRelayStatus(0,8); return $r[$addr]??false; }
            }
        } catch(Exception $e){ echo "[HW ERROR] " . $e->getMessage() . "\n"; }
    });

    // 3. Register SCL Functions
    $interpreter->register('CONNECT', function($ip, $p, $id) use (&$connections) {
        echo "[HW] Connecting $ip... ";
        $m = new ModbusRelayController($ip, $p, $id);
        try { $m->connect(); echo "OK\n"; } catch(Exception $e){ echo "FAIL\n"; }
        $connections[] = $m; return count($connections)-1;
    });

    $interpreter->register('MODBUS_MAP', function($mapArray) use ($server) {
        $server->setMapping($mapArray);
    });

    $interpreter->register('LOG', function($m){ echo "[LOG] $m\n"; });

    $interpreter->register('DISCONNECT_ALL', function() use (&$connections) {
        foreach($connections as $c) $c->disconnect();
    });

    $interpreter->register('WAIT', function($ms) use ($sclFile, &$lastMod, &$lastMapHash, $interpreter, $statusFile, $server) {
        if (file_exists('project.json')) {
            $mapContent = file_get_contents('project.json');
            $currentHash = md5($mapContent);

            if ($currentHash !== $lastMapHash) {
                $proj = json_decode($mapContent, true);
                if (isset($proj['vars'])) {
                    $map = ['coils' => [], 'di' => [], 'ir' => [], 'hr' => []];
        
                    foreach ($proj['vars'] as $index => $v) {
                    $isBool = ($v['type'] === 'BOOL');
                    // This is the key: read the 'io' string from your JSON
                    $isInput = (isset($v['io']) && $v['io'] === 'INPUT');

                    if ($isBool) {
                        if ($isInput) $map['di'][$index] = $v['name'];    // 1x (InputSw lands here)
                        else          $map['coils'][$index] = $v['name']; // 0x (Relays land here)
                    } else {
                        if ($isInput) $map['ir'][$index] = $v['name'];    // 3x
                        else          $map['hr'][$index] = $v['name'];    // 4x
                    }
                }
                $server->setFullMapping($map);
                $lastMapHash = $currentHash;
            }
        }
    }

    $server->handle($interpreter->memory);

    $statusData = [
        "variables" => $interpreter->memory,
        "mapping" => $server->getMapping()
    ];
    $tmpFile = $statusFile . '.tmp';
    file_put_contents($tmpFile, json_encode($statusData));
    @rename($tmpFile, $statusFile);

        // Check if project.scl was saved
        clearstatcache();
        if (file_exists($sclFile)) {
            $currentMod = filemtime($sclFile);
            if ($currentMod > $lastMod) {
                $lastMod = $currentMod;
                throw new ReloadSignal("File Changed");
            }
        }
        usleep($ms * 1000);
    });

    // 5. Execution Loop
    try {
        if (file_exists($sclFile)) {
            echo "[SYSTEM] Running Logic...\n";
            $code = file_get_contents($sclFile);
            if(!empty(trim($code))) {
                $lexer = new Lexer($code);
                $parser = new Parser($lexer);
                $ast = $parser->parse();
                $interpreter->run($ast); 
            }
        } else { sleep(1); }
    } catch (ReloadSignal $e) {
        echo "[RELOAD] Restarting engine due to code change.\n";
    } catch (Exception $e) {
        echo "[CRASH] " . $e->getMessage() . "\n";
        sleep(2);
    }

    // Cleanup hardware before reload
    foreach($connections as $c) try { $c->disconnect(); } catch(Exception $e){}
}

