// Parsed view of a program image (see docs/bytecode.md). The image buffer
// must stay alive and unchanged while the program is loaded.
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "config.h"

namespace vplc {

struct Blob {
    const uint8_t* data = nullptr;
    uint32_t size = 0;
};

struct Program {
    uint32_t id = 0;                 // CRC-32 of the image
    char name[33] = {0};
    uint32_t buildTime = 0;
    uint32_t dataSize = 0;
    uint16_t iSize = 0, qSize = 0, mSize = 0;
    uint16_t stackCells = 0, callDepth = 0, cycleMs = 10;
    Blob code, consts, init, funcs, lines, ioconf, syms, dbs, datalogs;
    // Communication services (SERVICES section)
    struct Services {
        bool opcua = false, opcuaWrite = true, opcuaAnonymous = true;
        uint16_t opcuaPort = 4840;
        bool s7 = false, s7Write = true;
        uint16_t s7Port = 102;
    } services;
    uint16_t funcCount = 0;
    uint16_t startup = 0xFFFF, main = 0xFFFF;

    // Function table entry
    uint32_t funcCode(uint16_t f) const;
    uint32_t funcFrame(uint16_t f) const;
    uint32_t funcFrameSize(uint16_t f) const;

    // Source line of a code address (0 if unknown); also returns the function index.
    uint16_t lineAt(uint32_t pc, uint16_t* func) const;
};

// Validates and parses an image. Returns nullptr on success, an error message otherwise.
const char* parseProgram(const uint8_t* image, size_t len, Program& out);

// Iterates over the I/O modules of the IOCONF section.
struct IoModuleInfo {
    uint8_t kind = 0;
    // MODBUS_TCP
    char host[64] = {0};
    uint16_t port = 502;
    uint8_t unit = 1;
    uint16_t diCount = 0, diByte = 0, coilCount = 0, coilByte = 0, irCount = 0, irByte = 0, hrCount = 0, hrByte = 0, pollMs = 0;
    // GPIO
    uint8_t pin = 0, bit = 0, flags = 0;
    uint16_t byte = 0;
    // IO-Link master (Modbus TCP): host/port/unit/pollMs above
    uint8_t inFunction = 3, portCount = 0;
    struct IoLinkPort {
        uint8_t port = 0;
        uint16_t inRegister = 0, inByte = 0, outRegister = 0, outByte = 0;
        uint8_t inLength = 0, outLength = 0;
    } ports[16];
    // PROFINET (device role and remote IO-Devices): host = IP address of a remote device
    char ifname[32] = {0};
    char station[241] = {0};
    uint16_t vendorId = 0, deviceId = 0;
    uint16_t inByte = 0, inLength = 0, outByte = 0, outLength = 0;  // device role
    uint16_t cycleMs = 8, watchdog = 3;                              // remote device
    uint8_t subCount = 0;
    struct PnSub {
        uint16_t slot = 0, subslot = 0;
        uint32_t moduleIdent = 0, submoduleIdent = 0;
        uint16_t inLength = 0, inByte = 0, outLength = 0, outByte = 0;
        uint16_t recordOffset = 0;  // in recordPool: per record u16 index, u16 length, data
        uint8_t recordCount = 0;
    } subs[VPLC_PN_MAX_SUBMODULES > 0 ? VPLC_PN_MAX_SUBMODULES : 1];
    uint8_t recordPool[VPLC_PN_RECORD_POOL > 0 ? VPLC_PN_RECORD_POOL : 1] = {0};
    uint16_t recordUsed = 0;
};

class IoModuleReader {
public:
    explicit IoModuleReader(const Blob& ioconf);
    uint16_t count() const { return count_; }
    // Reads the next module; false at the end or on malformed data.
    bool next(IoModuleInfo& m);

private:
    const uint8_t* p_;
    const uint8_t* end_;
    uint16_t count_ = 0, read_ = 0;
};

// Traceability: data logs of the DATALOGS section (see docs/bytecode.md)
struct DataLogColumn {
    char name[64] = {0};
    uint8_t area = 0, bit = 0xFF, type = 0;
    uint32_t offset = 0;
    uint16_t size = 0;
};

struct DataLogInfo {
    enum Trigger : uint8_t { PROGRAM = 0, EDGE = 1, PERIOD = 2 };
    enum DbKind : uint8_t { NONE = 0, POSTGRESQL = 1, MYSQL = 2 };
    char name[64] = {0};
    uint8_t trigger = PROGRAM;
    uint8_t edgeArea = 0, edgeBit = 0xFF;
    uint32_t edgeOffset = 0;
    uint32_t periodMs = 0;
    uint16_t retentionDays = 0;
    // Columns are read one by one (the section can hold many)
    uint8_t columnCount = 0;
    const uint8_t* columns = nullptr;
    const uint8_t* columnsEnd = nullptr;
    // Remote database
    uint8_t dbKind = NONE;
    char host[128] = {0};
    uint16_t port = 0;
    char database[64] = {0};
    char table[64] = {0};
    char user[64] = {0};
    uint8_t tls = 2;  // 0 disable, 1 require, 2 verify

    // Iterates over the columns: `pos` starts at 0
    bool column(uint8_t& pos, const uint8_t*& cursor, DataLogColumn& out) const;
    // Bytes of one record (bits take one byte)
    uint32_t recordSize() const;
};

class DataLogReader {
public:
    explicit DataLogReader(const Blob& section);
    uint16_t count() const { return count_; }
    bool next(DataLogInfo& log);

private:
    const uint8_t* p_;
    const uint8_t* end_;
    uint16_t count_ = 0, read_ = 0;
};

}  // namespace vplc
