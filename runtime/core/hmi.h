// Variables and data blocks exposed to HMIs (OPC UA, S7 communication): reading of the
// SYMS / DBS / SERVICES sections of the program and typed access to the PLC memory.
// Portable: no heap, no exceptions.
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "program.h"
#include "vm.h"

namespace vplc {

enum : uint8_t { HMI_STRING = 0x20, HMI_TIME = 0x21 };

struct SymbolInfo {
    uint8_t area = 0;
    uint32_t offset = 0;
    uint8_t bit = 0xFF;  // 0xFF: not a bit
    uint8_t type = 0;    // VM type code, HMI_STRING or HMI_TIME
    uint16_t size = 0;
    bool writable = false;
    uint8_t segments = 0;
    const uint8_t* path = nullptr;  // segments: u8 length + bytes
    uint32_t index = 0;             // position in the table

    // i-th path segment (not null-terminated)
    bool segment(uint8_t i, const char*& text, uint8_t& length) const;
    // Full path joined with `sep` into out (null-terminated, truncated to cap)
    size_t fullPath(char* out, size_t cap, char sep = '.') const;
};

class SymbolReader {
public:
    explicit SymbolReader(const Blob& syms);
    uint32_t count() const { return count_; }
    bool next(SymbolInfo& s);

private:
    const uint8_t* p_;
    const uint8_t* end_;
    uint32_t count_ = 0, read_ = 0;
};

struct DbInfo {
    uint16_t number = 0;
    uint32_t offset = 0, size = 0;
};

// Data block by number (DBS section).
bool findDb(const Blob& dbs, uint16_t number, DbInfo& out);

struct HmiValue {
    enum Kind : uint8_t { NONE, BOOL, INT, UINT, REAL, STRING } kind = NONE;
    bool b = false;
    int64_t i = 0;
    uint64_t u = 0;
    double f = 0;
    char s[256] = {0};
    uint8_t length = 0;
};

// Current value of a symbol (false if its memory is not available).
bool hmiRead(Vm& vm, const SymbolInfo& sym, HmiValue& out);
// Writes a value (converted to the symbol type, strings truncated to their maximum length).
// Returns nullptr on success, a reason otherwise.
const char* hmiWrite(Vm& vm, const SymbolInfo& sym, const HmiValue& value);

// Does the byte range [offset, offset+size) of `area` overlap a variable that HMIs may not
// write? Used to check absolute writes (S7) against the access rights of the variables.
bool hmiRangeReadOnly(const Blob& syms, uint8_t area, uint32_t offset, uint32_t size);

}  // namespace vplc
