<?php

class ModbusRelayController {
    private $ip;
    private $port;
    private $unitId;
    private $socket;
    private $transactionId = 0;
    private $timeout = 2; 

    const FC_READ_COILS = 1;
    const FC_READ_INPUTS = 2;
    const FC_WRITE_SINGLE_COIL = 5;
    const FC_WRITE_MULTIPLE_COILS = 15;

    public function __construct($ip, $port = 502, $unitId = 1) {
        $this->ip = $ip;
        $this->port = $port;
        $this->unitId = $unitId;
    }

    public function connect() {
        $this->socket = socket_create(AF_INET, SOCK_STREAM, SOL_TCP);
        if ($this->socket === false) throw new Exception("Socket creation failed");
        
        socket_set_option($this->socket, SOL_SOCKET, SO_RCVTIMEO, ['sec' => $this->timeout, 'usec' => 0]);
        socket_set_option($this->socket, SOL_SOCKET, SO_SNDTIMEO, ['sec' => $this->timeout, 'usec' => 0]);

        $result = @socket_connect($this->socket, $this->ip, $this->port);
        if ($result === false) throw new Exception("Connection failed to $this->ip");
    }

    public function disconnect() {
        if ($this->socket) { socket_close($this->socket); $this->socket = null; }
    }

    public function setRelay($relayIndex, $state) {
        $value = ($state === 'on' || $state === true) ? 0xFF00 : 0x0000;
        $data = pack('n', $relayIndex) . pack('n', $value);
        $this->sendRequest(self::FC_WRITE_SINGLE_COIL, $data);
    }

    public function flashRelay($relayIndex, $state, $durationMs) {
        $this->setRelay($relayIndex, $state);
        usleep($durationMs * 1000);
        $this->setRelay($relayIndex, !$state); // Toggle back
    }

    public function setAllRelays($state, $count = 8) {
        $isOn = ($state === 'on' || $state === true);
        $byteCount = ceil($count / 8);
        $bytes = array_fill(0, $byteCount, $isOn ? 0xFF : 0x00);
        $data = pack('n', 0) . pack('n', $count) . pack('C', $byteCount);
        foreach ($bytes as $b) $data .= pack('C', $b);
        $this->sendRequest(self::FC_WRITE_MULTIPLE_COILS, $data);
    }

    public function readRelayStatus($start = 0, $count = 8) {
        $data = pack('n', $start) . pack('n', $count);
        $response = $this->sendRequest(self::FC_READ_COILS, $data);
        return $this->bitsToArray(substr($response, 1), $count);
    }

    public function readInputStatus($start = 0, $count = 8) {
        $data = pack('n', $start) . pack('n', $count);
        $response = $this->sendRequest(self::FC_READ_INPUTS, $data);
        return $this->bitsToArray(substr($response, 1), $count);
    }

    private function sendRequest($fc, $data) {
        if (!$this->socket) $this->connect();
        $this->transactionId++;
        $pdu = pack('C', $fc) . $data;
        $header = pack('n', $this->transactionId) . pack('n', 0) . pack('n', strlen($pdu) + 1) . pack('C', $this->unitId);
        socket_write($this->socket, $header . $pdu);
        
        $headerRes = socket_read($this->socket, 6);
        if (strlen($headerRes) < 6) throw new Exception("Response error");
        $unpacked = unpack('nTrans/nProto/nLen', $headerRes);
        $bodyRes = socket_read($this->socket, $unpacked['Len']);
        if (ord($bodyRes[1]) > 0x80) throw new Exception("Modbus Error Code: " . ord($bodyRes[2]));
        return substr($bodyRes, 2);
    }

    private function bitsToArray($binaryString, $count) {
        $status = [];
        $byteArr = array_values(unpack('C*', $binaryString));
        for ($i = 0; $i < $count; $i++) {
            $byteIndex = floor($i / 8);
            $bitIndex = $i % 8;
            $status[$i] = (isset($byteArr[$byteIndex]) && ($byteArr[$byteIndex] & (1 << $bitIndex))) ? true : false;
        }
        return $status;
    }
}