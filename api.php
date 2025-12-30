<?php
// api.php
header('Content-Type: application/json');

// Files used by the system
$projectFile = 'project.json';
$sclFile = 'project.scl';
$statusFile = 'status.json';

// Get Action
$action = $_GET['action'] ?? '';

// --- 1. SAVE PROJECT (JSON) ---
if ($action === 'save') {
    $input = file_get_contents('php://input');
    if (!$input) { echo json_encode(['error' => 'No data']); exit; }
    file_put_contents($projectFile, $input);
    echo json_encode(['status' => 'success', 'message' => 'Project saved.']);
    exit;
}

// --- 2. LOAD PROJECT (JSON) ---
if ($action === 'load') {
    if (file_exists($projectFile)) {
        echo file_get_contents($projectFile);
    } else {
        echo json_encode(['hardware'=>[], 'vars'=>[], 'db'=>[], 'blocks'=>[], 'fc'=>'']);
    }
    exit;
}

// --- 3. DEPLOY (COMPILE JSON -> SCL) ---
if ($action === 'deploy') {
    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input) { echo json_encode(['error' => 'No data received']); exit; }

    // Start Building SCL Content
    $scl = "// AUTO-GENERATED SCL - " . date('Y-m-d H:i:s') . "\n\n";

    // Hardware
    $scl .= "HARDWARE\n";
    foreach ($input['hardware'] as $h) {
        $scl .= "    {$h['name']} := CONNECT('{$h['ip']}', {$h['port']}, {$h['slave']});\n";
    }
    $scl .= "END_HARDWARE\n\n";

    // Variables
    $scl .= "VAR\n";
    foreach ($input['vars'] as $v) {
        if ($v['mode'] === 'binding') {
            $scl .= "    {$v['name']} : {$v['device']}.{$v['io']}.{$v['addr']};\n";
        } else {
            $scl .= "    {$v['name']} : {$v['type']};\n";
        }
    }
    $scl .= "END_VAR\n\n";

    // Data Block
    $scl .= "DB\n";
    foreach ($input['db'] as $d) {
        $val = strtoupper($d['val']);
        if ($val !== 'TRUE' && $val !== 'FALSE' && !is_numeric($val)) $val = 0;
        $scl .= "    {$d['name']} := {$val};\n";
    }
    $scl .= "END_DB\n\n";

    // Custom Blocks
    if (isset($input['blocks'])) {
        foreach ($input['blocks'] as $b) {
            $scl .= "BLOCK {$b['name']}\n";
            $scl .= $b['code'] . "\n";
            $scl .= "END_BLOCK\n\n";
        }
    }

    // Main FC
    $scl .= "FC\n";
    $scl .= $input['fc'] . "\n";
    $scl .= "END_FC\n";

    // Write SCL to disk (This triggers the Daemon to reload)
    if (file_put_contents($sclFile, $scl) === false) {
        echo json_encode(['status' => 'error', 'error' => 'Permission denied: Cannot write project.scl']);
    } else {
        echo json_encode(['status' => 'success', 'message' => 'Deployed successfully!']);
    }
    exit;
}

// --- 4. STATUS (LIVE MONITOR) ---
if ($action === 'status') {
    if (file_exists($statusFile)) {
        echo file_get_contents($statusFile);
    } else {
        echo json_encode([]);
    }
    exit;
}