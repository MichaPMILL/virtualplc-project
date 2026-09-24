<?php

declare(strict_types=1);

namespace VirtualPLC\Modbus;

use VirtualPLC\Scl\SclException;
use VirtualPLC\Scl\TagStore;
use VirtualPLC\Support\Logger;

/**
 * Non-blocking Modbus TCP server (slave) exposing program variables to HMIs.
 *
 * Designed to be polled from the PLC scan loop: {@see poll()} never blocks
 * longer than the given timeout.
 *
 * Supported functions: 01, 02, 03, 04, 05, 06, 15, 16. Reads of unmapped
 * addresses return 0; writes to unmapped addresses are ignored.
 */
final class ModbusTcpServer
{
    private const MAX_ADU = 260;

    /** @var resource */
    private $server;

    /** @var array<int, resource> */
    private array $clients = [];

    /** @var array<int, string> receive buffers per client */
    private array $buffers = [];

    private RegisterMap $map;
    private ?TagStore $store = null;

    public function __construct(
        private readonly string $bindAddress = '0.0.0.0',
        private readonly int $port = 5020,
        private readonly Logger $logger = new Logger(),
        private readonly int $maxClients = 16,
    ) {
        $this->map = new RegisterMap();
        $host = str_contains($bindAddress, ':') ? "[{$bindAddress}]" : $bindAddress;
        $errno = 0;
        $errstr = '';
        $server = @stream_socket_server("tcp://{$host}:{$port}", $errno, $errstr);
        if ($server === false) {
            throw new ModbusException("Cannot listen on {$bindAddress}:{$port}: {$errstr} ({$errno})");
        }
        stream_set_blocking($server, false);
        $this->server = $server;
        $this->logger->info('Modbus TCP server listening', ['address' => "{$bindAddress}:{$this->localPort()}"]);
    }

    public function __destruct()
    {
        $this->close();
    }

    /** Actual listening port (useful when constructed with port 0). */
    public function localPort(): int
    {
        $name = stream_socket_get_name($this->server, false);

        return $name === false ? $this->port : (int) substr($name, strrpos($name, ':') + 1);
    }

    public function setRegisterMap(RegisterMap $map): void
    {
        $this->map = $map;
        $this->logger->info('Register map updated', [
            'coils' => count($map->coils),
            'discrete_inputs' => count($map->discreteInputs),
            'holding_registers' => count($map->holdingRegisters),
        ]);
    }

    public function registerMap(): RegisterMap
    {
        return $this->map;
    }

    /** Store backing the registers; null makes the server answer "device failure". */
    public function setTagStore(?TagStore $store): void
    {
        $this->store = $store;
    }

    public function clientCount(): int
    {
        return count($this->clients);
    }

    /**
     * Accepts connections and serves pending requests.
     * Waits at most $timeout seconds for activity.
     */
    public function poll(float $timeout = 0.0): void
    {
        $read = [$this->server, ...array_values($this->clients)];
        $write = null;
        $except = null;
        $seconds = (int) $timeout;
        $micro = (int) (($timeout - $seconds) * 1e6);

        $ready = @stream_select($read, $write, $except, $seconds, $micro);
        if ($ready === false || $ready === 0) {
            return;
        }

        foreach ($read as $stream) {
            if ($stream === $this->server) {
                $this->accept();
            } else {
                $this->receive($stream);
            }
        }
    }

    public function close(): void
    {
        foreach (array_keys($this->clients) as $id) {
            $this->drop($id, null);
        }
        if (is_resource($this->server)) {
            @fclose($this->server);
        }
    }

    /**
     * Processes a single request PDU and returns the response PDU.
     * Public so that it can be unit-tested without sockets.
     */
    public function handlePdu(string $pdu): string
    {
        $function = ord($pdu[0] ?? "\0");

        try {
            if ($this->store === null) {
                throw new ModbusException('No program running', ModbusException::SERVER_DEVICE_FAILURE);
            }

            return chr($function) . match ($function) {
                FunctionCode::READ_COILS => $this->readBits($pdu, $this->map->coils),
                FunctionCode::READ_DISCRETE_INPUTS => $this->readBits($pdu, $this->map->discreteInputs),
                FunctionCode::READ_HOLDING_REGISTERS => $this->readRegisters($pdu, $this->map->holdingRegisters, false),
                FunctionCode::READ_INPUT_REGISTERS => $this->readRegisters($pdu, $this->map->inputRegisters, true),
                FunctionCode::WRITE_SINGLE_COIL => $this->writeSingleCoil($pdu),
                FunctionCode::WRITE_SINGLE_REGISTER => $this->writeSingleRegister($pdu),
                FunctionCode::WRITE_MULTIPLE_COILS => $this->writeMultipleCoils($pdu),
                FunctionCode::WRITE_MULTIPLE_REGISTERS => $this->writeMultipleRegisters($pdu),
                default => throw new ModbusException('Illegal function', ModbusException::ILLEGAL_FUNCTION),
            };
        } catch (ModbusException $e) {
            return chr(($function | 0x80) & 0xFF) . chr($e->getCode() ?: ModbusException::SERVER_DEVICE_FAILURE);
        }
    }

    // ------------------------------------------------------------------
    // Connection handling
    // ------------------------------------------------------------------

    private function accept(): void
    {
        $client = @stream_socket_accept($this->server, 0, $peer);
        if ($client === false) {
            return;
        }
        if (count($this->clients) >= $this->maxClients) {
            $this->logger->warning('Connection refused: too many clients', ['peer' => $peer, 'max' => $this->maxClients]);
            @fclose($client);
            return;
        }
        stream_set_blocking($client, false);
        $id = (int) $client;
        $this->clients[$id] = $client;
        $this->buffers[$id] = '';
        $this->logger->info('HMI connected', ['peer' => $peer, 'clients' => count($this->clients)]);
    }

    /** @param resource $client */
    private function receive($client): void
    {
        $id = (int) $client;
        $data = @fread($client, 4096);
        if ($data === false || ($data === '' && feof($client))) {
            $this->drop($id, 'disconnected');
            return;
        }

        $this->buffers[$id] .= $data;

        // A single read may contain several (or partial) frames.
        while (strlen($this->buffers[$id]) >= 7) {
            $header = unpack('ntid/npid/nlen/Cuid', $this->buffers[$id]);
            if ($header === false || $header['pid'] !== 0 || $header['len'] < 2 || $header['len'] + 6 > self::MAX_ADU) {
                $this->drop($id, 'protocol error');
                return;
            }
            $frameLength = 6 + $header['len'];
            if (strlen($this->buffers[$id]) < $frameLength) {
                return; // wait for the rest of the frame
            }
            $pdu = substr($this->buffers[$id], 7, $header['len'] - 1);
            $this->buffers[$id] = (string) substr($this->buffers[$id], $frameLength);

            $response = $this->handlePdu($pdu);
            $adu = pack('nnnC', $header['tid'], 0, strlen($response) + 1, $header['uid']) . $response;
            if (@fwrite($client, $adu) === false) {
                $this->drop($id, 'write failed');
                return;
            }
        }
    }

    private function drop(int $id, ?string $reason): void
    {
        if (isset($this->clients[$id])) {
            @fclose($this->clients[$id]);
        }
        unset($this->clients[$id], $this->buffers[$id]);
        if ($reason !== null) {
            $this->logger->info("HMI {$reason}", ['clients' => count($this->clients)]);
        }
    }

    // ------------------------------------------------------------------
    // Function handlers (return the PDU data after the function code)
    // ------------------------------------------------------------------

    /** @return array{0: int, 1: int} */
    private function addressAndQuantity(string $pdu, int $max): array
    {
        if (strlen($pdu) < 5) {
            throw new ModbusException('Truncated request', ModbusException::ILLEGAL_DATA_VALUE);
        }
        ['a' => $address, 'q' => $quantity] = unpack('na/nq', $pdu, 1) ?: ['a' => 0, 'q' => 0];
        if ($quantity < 1 || $quantity > $max) {
            throw new ModbusException('Illegal quantity', ModbusException::ILLEGAL_DATA_VALUE);
        }
        if ($address + $quantity > 0x10000) {
            throw new ModbusException('Illegal address', ModbusException::ILLEGAL_DATA_ADDRESS);
        }

        return [$address, $quantity];
    }

    /** @param array<int, string> $table */
    private function readBits(string $pdu, array $table): string
    {
        [$address, $quantity] = $this->addressAndQuantity($pdu, FunctionCode::MAX_READ_BITS);
        $bits = [];
        for ($i = 0; $i < $quantity; $i++) {
            $tag = $table[$address + $i] ?? null;
            $bits[] = $tag !== null && (bool) $this->read($tag);
        }
        $bytes = Bits::pack($bits);

        return chr(strlen($bytes)) . $bytes;
    }

    /** @param array<int, string> $table */
    private function readRegisters(string $pdu, array $table, bool $withNameTable): string
    {
        [$address, $quantity] = $this->addressAndQuantity($pdu, FunctionCode::MAX_READ_REGISTERS);
        $values = [];
        for ($i = 0; $i < $quantity; $i++) {
            $register = $address + $i;
            if ($withNameTable && $register >= RegisterMap::NAME_TABLE_BASE) {
                $values[] = $this->map->nameRegister($register);
                continue;
            }
            $tag = $table[$register] ?? null;
            $values[] = $tag === null ? 0 : ((int) $this->read($tag)) & 0xFFFF;
        }

        return chr($quantity * 2) . pack('n*', ...$values);
    }

    private function writeSingleCoil(string $pdu): string
    {
        if (strlen($pdu) < 5) {
            throw new ModbusException('Truncated request', ModbusException::ILLEGAL_DATA_VALUE);
        }
        ['a' => $address, 'v' => $value] = unpack('na/nv', $pdu, 1) ?: ['a' => 0, 'v' => 0];
        if ($value !== 0xFF00 && $value !== 0x0000) {
            throw new ModbusException('Illegal coil value', ModbusException::ILLEGAL_DATA_VALUE);
        }
        $this->writeMapped($this->map->coils, $address, $value === 0xFF00);

        return substr($pdu, 1, 4);
    }

    private function writeSingleRegister(string $pdu): string
    {
        if (strlen($pdu) < 5) {
            throw new ModbusException('Truncated request', ModbusException::ILLEGAL_DATA_VALUE);
        }
        ['a' => $address, 'v' => $value] = unpack('na/nv', $pdu, 1) ?: ['a' => 0, 'v' => 0];
        $this->writeMapped($this->map->holdingRegisters, $address, self::toSigned($value));

        return substr($pdu, 1, 4);
    }

    private function writeMultipleCoils(string $pdu): string
    {
        [$address, $quantity] = $this->addressAndQuantity($pdu, FunctionCode::MAX_WRITE_BITS);
        $byteCount = ord($pdu[5] ?? "\0");
        if ($byteCount !== (int) ceil($quantity / 8) || strlen($pdu) < 6 + $byteCount) {
            throw new ModbusException('Byte count mismatch', ModbusException::ILLEGAL_DATA_VALUE);
        }
        foreach (Bits::unpack(substr($pdu, 6, $byteCount), $quantity) as $i => $bit) {
            $this->writeMapped($this->map->coils, $address + $i, $bit);
        }

        return pack('nn', $address, $quantity);
    }

    private function writeMultipleRegisters(string $pdu): string
    {
        [$address, $quantity] = $this->addressAndQuantity($pdu, FunctionCode::MAX_WRITE_REGISTERS);
        $byteCount = ord($pdu[5] ?? "\0");
        if ($byteCount !== $quantity * 2 || strlen($pdu) < 6 + $byteCount) {
            throw new ModbusException('Byte count mismatch', ModbusException::ILLEGAL_DATA_VALUE);
        }
        $values = array_values(unpack('n*', substr($pdu, 6, $byteCount)) ?: []);
        foreach ($values as $i => $value) {
            $this->writeMapped($this->map->holdingRegisters, $address + $i, self::toSigned($value));
        }

        return pack('nn', $address, $quantity);
    }

    // ------------------------------------------------------------------
    // Store access
    // ------------------------------------------------------------------

    private function read(string $tag): mixed
    {
        try {
            return $this->store?->readTag($tag);
        } catch (SclException) {
            return null;
        }
    }

    /** @param array<int, string> $table */
    private function writeMapped(array $table, int $address, bool|int $value): void
    {
        $tag = $table[$address] ?? null;
        if ($tag === null || $this->store === null) {
            return;
        }
        try {
            $this->store->writeTag($tag, $value);
            $this->logger->info('HMI write', ['tag' => $tag, 'value' => $value]);
        } catch (SclException $e) {
            $this->logger->warning('HMI write rejected', ['tag' => $tag, 'reason' => $e->getMessage()]);
            throw new ModbusException($e->getMessage(), ModbusException::SERVER_DEVICE_FAILURE, $e);
        }
    }

    private static function toSigned(int $value): int
    {
        return $value >= 0x8000 ? $value - 0x10000 : $value;
    }
}
