<?php

declare(strict_types=1);

namespace VirtualPLC\Modbus;

/**
 * Minimal, robust Modbus TCP client (master).
 *
 * - Connect/read/write timeouts
 * - Exact-length reads (handles TCP fragmentation)
 * - Transaction id validation (resynchronises by reconnecting on mismatch)
 * - Any I/O error closes the socket; the next request reconnects transparently
 */
final class ModbusTcpClient
{
    /** @var resource|null */
    private $socket = null;
    private int $transactionId = 0;

    public function __construct(
        public readonly string $host,
        public readonly int $port = 502,
        public readonly int $unitId = 1,
        private readonly float $timeout = 1.0,
    ) {
        if ($port < 1 || $port > 65535) {
            throw new \InvalidArgumentException("Invalid port {$port}");
        }
        if ($unitId < 0 || $unitId > 255) {
            throw new \InvalidArgumentException("Invalid unit id {$unitId}");
        }
    }

    public function __destruct()
    {
        $this->disconnect();
    }

    public function connect(): void
    {
        if ($this->socket !== null) {
            return;
        }

        $host = str_contains($this->host, ':') ? "[{$this->host}]" : $this->host;
        $errno = 0;
        $errstr = '';
        $socket = @stream_socket_client("tcp://{$host}:{$this->port}", $errno, $errstr, $this->timeout);
        if ($socket === false) {
            throw new ModbusException("Cannot connect to {$this->host}:{$this->port}: {$errstr} ({$errno})");
        }

        $seconds = (int) $this->timeout;
        stream_set_timeout($socket, $seconds, (int) (($this->timeout - $seconds) * 1e6));
        $this->socket = $socket;
    }

    public function disconnect(): void
    {
        if ($this->socket !== null) {
            @fclose($this->socket);
            $this->socket = null;
        }
    }

    public function isConnected(): bool
    {
        return $this->socket !== null;
    }

    /** @return list<bool> */
    public function readCoils(int $start, int $count): array
    {
        $this->checkRange($start, $count, FunctionCode::MAX_READ_BITS);
        $data = $this->request(FunctionCode::READ_COILS, pack('nn', $start, $count));

        return Bits::unpack(substr($data, 1), $count);
    }

    /** @return list<bool> */
    public function readDiscreteInputs(int $start, int $count): array
    {
        $this->checkRange($start, $count, FunctionCode::MAX_READ_BITS);
        $data = $this->request(FunctionCode::READ_DISCRETE_INPUTS, pack('nn', $start, $count));

        return Bits::unpack(substr($data, 1), $count);
    }

    /** @return list<int> unsigned 16-bit values */
    public function readHoldingRegisters(int $start, int $count): array
    {
        $this->checkRange($start, $count, FunctionCode::MAX_READ_REGISTERS);
        $data = $this->request(FunctionCode::READ_HOLDING_REGISTERS, pack('nn', $start, $count));

        return array_values(unpack('n*', substr($data, 1)) ?: []);
    }

    /** @return list<int> unsigned 16-bit values */
    public function readInputRegisters(int $start, int $count): array
    {
        $this->checkRange($start, $count, FunctionCode::MAX_READ_REGISTERS);
        $data = $this->request(FunctionCode::READ_INPUT_REGISTERS, pack('nn', $start, $count));

        return array_values(unpack('n*', substr($data, 1)) ?: []);
    }

    public function writeSingleCoil(int $address, bool $value): void
    {
        $this->checkRange($address, 1, 1);
        $this->request(FunctionCode::WRITE_SINGLE_COIL, pack('nn', $address, $value ? 0xFF00 : 0x0000));
    }

    public function writeSingleRegister(int $address, int $value): void
    {
        $this->checkRange($address, 1, 1);
        $this->request(FunctionCode::WRITE_SINGLE_REGISTER, pack('nn', $address, $value & 0xFFFF));
    }

    /** @param list<bool> $values */
    public function writeMultipleCoils(int $start, array $values): void
    {
        $this->checkRange($start, count($values), FunctionCode::MAX_WRITE_BITS);
        $bytes = Bits::pack($values);
        $this->request(FunctionCode::WRITE_MULTIPLE_COILS, pack('nnC', $start, count($values), strlen($bytes)) . $bytes);
    }

    /** @param list<int> $values */
    public function writeMultipleRegisters(int $start, array $values): void
    {
        $this->checkRange($start, count($values), FunctionCode::MAX_WRITE_REGISTERS);
        $payload = pack('n*', ...array_map(static fn (int $v): int => $v & 0xFFFF, $values));
        $this->request(FunctionCode::WRITE_MULTIPLE_REGISTERS, pack('nnC', $start, count($values), strlen($payload)) . $payload);
    }

    /**
     * Sends a request PDU and returns the response PDU data (without the function code).
     */
    private function request(int $functionCode, string $data): string
    {
        $this->connect();
        $this->transactionId = ($this->transactionId + 1) & 0xFFFF;
        $pdu = chr($functionCode) . $data;
        $adu = pack('nnnC', $this->transactionId, 0, strlen($pdu) + 1, $this->unitId) . $pdu;

        try {
            $this->writeAll($adu);
            $header = unpack('ntid/npid/nlen/Cuid', $this->readExactly(7));
            if ($header === false || $header['pid'] !== 0 || $header['len'] < 2 || $header['len'] > 254) {
                throw new ModbusException('Malformed MBAP header in response');
            }
            $body = $this->readExactly($header['len'] - 1);
            if ($header['tid'] !== $this->transactionId) {
                throw new ModbusException("Transaction id mismatch (expected {$this->transactionId}, got {$header['tid']})");
            }
        } catch (ModbusException $e) {
            // The stream is in an unknown state: drop it so the next request reconnects cleanly.
            $this->disconnect();
            throw $e;
        }

        $responseCode = ord($body[0]);
        if ($responseCode === ($functionCode | 0x80)) {
            throw ModbusException::fromExceptionCode($functionCode, strlen($body) > 1 ? ord($body[1]) : 0);
        }
        if ($responseCode !== $functionCode) {
            $this->disconnect();
            throw new ModbusException(sprintf('Unexpected function code 0x%02X in response', $responseCode));
        }

        return substr($body, 1);
    }

    private function writeAll(string $bytes): void
    {
        $socket = $this->socket ?? throw new ModbusException('Not connected');
        $offset = 0;
        while ($offset < strlen($bytes)) {
            $written = @fwrite($socket, substr($bytes, $offset));
            if ($written === false || $written === 0) {
                throw new ModbusException("Write to {$this->host}:{$this->port} failed");
            }
            $offset += $written;
        }
    }

    private function readExactly(int $length): string
    {
        $socket = $this->socket ?? throw new ModbusException('Not connected');
        $buffer = '';
        while (strlen($buffer) < $length) {
            $chunk = @fread($socket, $length - strlen($buffer));
            if ($chunk === false || $chunk === '') {
                $meta = stream_get_meta_data($socket);
                $reason = $meta['timed_out'] ? 'timeout' : 'connection closed';
                throw new ModbusException("Read from {$this->host}:{$this->port} failed ({$reason})");
            }
            $buffer .= $chunk;
        }

        return $buffer;
    }

    private function checkRange(int $start, int $count, int $max): void
    {
        if ($count < 1 || $count > $max) {
            throw new \InvalidArgumentException("Quantity {$count} out of range (1-{$max})");
        }
        if ($start < 0 || $start + $count > 0x10000) {
            throw new \InvalidArgumentException("Address range {$start}+{$count} out of bounds");
        }
    }
}
