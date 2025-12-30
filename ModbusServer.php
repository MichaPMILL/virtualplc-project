<?php
// ModbusServer.php
class ModbusServer {
    private $socket;
    private $clients = [];
    private $mapping = ['coils' => [], 'di' => [], 'ir' => [], 'hr' => []];
    private $memory; 


    public function __construct($port = 5020, $mapping = []) {
        $this->mapping = $mapping;
        // Create a TCP Stream Socket
        $this->socket = stream_socket_server("tcp://0.0.0.0:$port", $errno, $errstr);
        if (!$this->socket) die("Modbus Server Error: $errstr ($errno)\n");
        
        // Set non-blocking mode
        stream_set_blocking($this->socket, 0);
        echo "[MODBUS] Server listening on port $port\n";
    }


    public function handle(&$memory) {
        $this->memory = &$memory; // Ensure internal reference is synced
        
        $read = array_merge([$this->socket], $this->clients);
        $write = null;
        $except = null;
        
        if (stream_select($read, $write, $except, 0) > 0) {
            if (in_array($this->socket, $read)) {
                $client = stream_socket_accept($this->socket);
                stream_set_blocking($client, 0); // Make client non-blocking too
                $this->clients[] = $client;
                echo "[MODBUS] HMI Connected\n";
                $key = array_search($this->socket, $read);
                unset($read[$key]);
            }

            foreach ($read as $client) {
                $data = fread($client, 1024);
                if (!$data) {
                    $key = array_search($client, $this->clients);
                    unset($this->clients[$key]);
                    @fclose($client);
                    echo "[MODBUS] HMI Disconnected\n";
                    continue;
                }

                // Pass the internal reference
                $response = $this->processPacket($data, $this->memory);
                if ($response) fwrite($client, $response);
            }
        }
    }
    
    public function &getMemory() {
        return $this->memory;
    }

    public function setFullMapping($map) {
        $this->mapping = $map;
        echo "[MODBUS] Map Updated: " . 
        count($map['coils']) . " Coils, " . 
        count($map['di'])    . " DIs, " . 
        count($map['ir'])    . " IRs, " . 
        count($map['hr'])    . " HRs active.\n";
    }

    private function processPacket($data, &$memory) {
        // 1. Basic validation (Header 7 bytes + Func 1 byte + Data 4 bytes)
        if (strlen($data) < 12) return null;

        // 2. Extract MBAP Header and Function Code
        $header = unpack('nTransId/nProtoId/nLen/CUnitId', substr($data, 0, 7));
        $funcCode = ord($data[7]);
        $startAddr = unpack('n', substr($data, 8, 2))[1];
        $count = unpack('n', substr($data, 10, 2))[1];

        // 3. Define Response Header immediately
        $respHeader = pack('nn', $header['TransId'], $header['ProtoId']);

        // 4. Select the correct mapping bin based on Function Code
        $targetBin = [];
        switch($funcCode) {
            case 1: $targetBin = $this->mapping['coils']; break; // 0x
            case 2: $targetBin = $this->mapping['di'];    break; // 1x
            case 3: $targetBin = $this->mapping['hr'];    break; // 4x
            case 4: $targetBin = $this->mapping['ir'];    break; // 3x
            case 5: $targetBin = $this->mapping['coils']; break;
            case 6: $targetBin = $this->mapping['hr'];    break;
        }

        // --- FEATURE: CLEAR NAME DISCOVERY (ASCII strings at Addr 1000+) ---
        if ($funcCode === 4 && $startAddr >= 1000) {
            $varIndex = floor(($startAddr - 1000) / 10);
            // Combine all bins to find the name associated with this global index
            $allNames = $this->mapping['coils'] + $this->mapping['di'] + $this->mapping['hr'] + $this->mapping['ir'];
            ksort($allNames);
        
            $name = isset($allNames[$varIndex]) ? $allNames[$varIndex] : "EMPTY";
        
            // Convert string to 16-bit registers (ASCII)
            $responseData = "";
            $paddedName = str_pad(substr($name, 0, $count * 2), $count * 2, "\0");
            for ($i = 0; $i < $count; $i++) {
                $chars = substr($paddedName, $i * 2, 2);
                $responseData .= $chars; 
            }
        
            $byteCount = strlen($responseData);
            $totalLen = 3 + $byteCount;
            return $respHeader . pack('nCCC', $totalLen, $header['UnitId'], $funcCode, $byteCount) . $responseData;
        }

        // --- HANDLE READS (FC 1, 2, 3, 4) ---
        if (in_array($funcCode, [1, 2, 3, 4])) {
            $responseData = "";
        
            if ($funcCode === 3 || $funcCode === 4) { // 16-bit Registers (HR/IR)
                for ($i = 0; $i < $count; $i++) {
                    $addr = $startAddr + $i;
                    $val = (isset($targetBin[$addr]) && isset($memory[$targetBin[$addr]])) 
                       ? (int)$memory[$targetBin[$addr]] : 0;
                    $responseData .= pack('n', $val);
                }
                $byteCount = $count * 2;
            } 
            else { // Bit-based (Coils/DI)
                $byteCount = (int)ceil($count / 8);
                $tempBytes = array_fill(0, $byteCount, 0);
                for ($i = 0; $i < $count; $i++) {
                    $addr = $startAddr + $i;
                    if (isset($targetBin[$addr]) && isset($memory[$targetBin[$addr]]) && $memory[$targetBin[$addr]]) {
                        $byteIdx = (int)($i / 8);
                        $bitIdx = $i % 8;
                        $tempBytes[$byteIdx] |= (1 << $bitIdx);
                    }
                }
                foreach ($tempBytes as $b) $responseData .= chr($b);
            }

            $totalLen = 3 + strlen($responseData);
            return $respHeader . pack('nCCC', $totalLen, $header['UnitId'], $funcCode, $byteCount) . $responseData;
        }

        // --- HANDLE WRITE SINGLE REGISTER (FC 6) ---
        if ($funcCode === 6) {
            $val = unpack('n', substr($data, 10, 2))[1];
            if (isset($targetBin[$startAddr])) {
                $varName = $targetBin[$startAddr];
                $memory[$varName] = $val;
                echo "[MODBUS] HMI Write HR: $varName = $val\n";
            }
            $totalLen = 6;
            return $respHeader . pack('n', $totalLen) . substr($data, 6, 6);
        }

        // --- HANDLE WRITE SINGLE COIL (FC 5) ---
        if ($funcCode === 5) {
            $val = unpack('n', substr($data, 10, 2))[1]; // 0xFF00 is ON, 0x0000 is OFF
            if (isset($targetBin[$startAddr])) {
                $varName = $targetBin[$startAddr];
                $memory[$varName] = ($val === 0xFF00);
                echo "[MODBUS] HMI Write Coil: $varName = " . ($memory[$varName] ? "ON" : "OFF") . "\n";
            }
            $totalLen = 6;
            return $respHeader . pack('n', $totalLen) . substr($data, 6, 6);
        }

        return null;
    }

    public function setMapping($newMapping) {
        $this->mapping = $newMapping;
        echo "[MODBUS] Mapping updated. " . count($this->mapping) . " registers active.\n";
    }
    public function getMapping() {
        return $this->mapping;
    }

    private function stringToRegisters($string, $regCount = 10) {
        $regs = array_fill(0, $regCount, 0);
        $chars = str_split(substr($string, 0, $regCount * 2));
        for ($i = 0; $i < count($chars); $i += 2) {
            $high = ord($chars[$i]);
            $low = isset($chars[$i+1]) ? ord($chars[$i+1]) : 0;
            $regs[$i/2] = ($high << 8) | $low;
        }
        return $regs;
    }
}
