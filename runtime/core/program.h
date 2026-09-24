// Parsed view of a program image (see docs/bytecode.md). The image buffer
// must stay alive and unchanged while the program is loaded.
#pragma once
#include <stddef.h>
#include <stdint.h>

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
    Blob code, consts, init, funcs, lines, ioconf;
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

}  // namespace vplc
