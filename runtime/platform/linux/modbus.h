// Minimal Modbus TCP client (remote I/O) and server (HMI access) for Linux.
#pragma once
#include <stdint.h>

#include <string>
#include <vector>

namespace vplc {

class ModbusClient {
public:
    ModbusClient(std::string host, uint16_t port, uint8_t unit, int timeoutMs);
    ~ModbusClient();
    ModbusClient(const ModbusClient&) = delete;
    ModbusClient& operator=(const ModbusClient&) = delete;

    bool readBits(uint8_t function, uint16_t start, uint16_t count, std::vector<bool>& out);
    bool readRegisters(uint8_t function, uint16_t start, uint16_t count, std::vector<uint16_t>& out);
    bool writeCoils(uint16_t start, const std::vector<bool>& values);
    bool writeRegisters(uint16_t start, const std::vector<uint16_t>& values);
    void close();
    const std::string& error() const { return error_; }
    const std::string& host() const { return host_; }

private:
    bool connect();
    bool transact(const std::vector<uint8_t>& pdu, std::vector<uint8_t>& response);
    bool sendAll(const uint8_t* data, size_t len);
    bool recvAll(uint8_t* data, size_t len);

    std::string host_;
    uint16_t port_;
    uint8_t unit_;
    int timeoutMs_;
    int fd_ = -1;
    uint16_t tid_ = 0;
    std::string error_;
};

// Memory exposed to HMIs: coils = %M bits, discrete inputs = %I bits,
// input registers = %IW, holding registers = %MW (big-endian words).
struct ModbusAreas {
    uint8_t* i = nullptr;
    uint32_t iSize = 0;
    uint8_t* m = nullptr;
    uint32_t mSize = 0;
};

// Processes one Modbus request PDU and returns the response PDU.
std::vector<uint8_t> modbusServe(const uint8_t* pdu, size_t len, const ModbusAreas& areas);

}  // namespace vplc
