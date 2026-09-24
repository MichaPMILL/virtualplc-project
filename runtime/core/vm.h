// VirtualPLC virtual machine: executes the bytecode of a Program.
// No heap allocation, no exceptions: all memory comes from a caller-provided arena.
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "config.h"
#include "program.h"

namespace vplc {

union Cell {
    int64_t i;
    double f;
};

// Services the VM needs from its host.
class VmHost {
public:
    virtual ~VmHost() = default;
    virtual uint32_t millis() = 0;
    // Clock used by the watchdog (a real clock, even when millis() is simulated).
    virtual uint32_t watchdogMillis() { return millis(); }
    virtual void log(const char* message) = 0;
    virtual bool moduleOk(uint16_t index) = 0;
    // True when the I/O module (e.g. a PROFINET device) reports an active diagnosis
    virtual bool moduleDiag(uint16_t index) { (void)index; return false; }
    // Alarm sent by the CPU as PROFINET IO-Device (kind 1 diagnosis appears, 12 disappears, 2 process)
    virtual bool alarm(uint16_t module, uint16_t slot, uint16_t kind, uint32_t code) { (void)module; (void)slot; (void)kind; (void)code; return false; }
    // Date and time in ns since 1970-01-01 (UTC, or local time); false if the device has no clock.
    virtual bool clock(bool local, int64_t& ns) { (void)local; ns = 0; return false; }
    // DATALOG_WRITE: records the data log at the end of the scan; false if not possible
    virtual bool dataLogRequest(uint16_t log) { (void)log; return false; }
};

struct Fault {
    uint8_t code = 0;     // Trap code (0 = none)
    uint32_t pc = 0;
    uint16_t function = 0xFFFF;
    uint16_t line = 0;
};

class Vm {
public:
    enum Result : uint8_t { DONE, WAITING, TRAPPED };

    // Bytes of arena needed by a program.
    static size_t arenaSize(const Program& p);

    // Binds a parsed program to an arena of at least arenaSize(p) bytes.
    bool load(const Program* program, uint8_t* arena, size_t size, VmHost* host);
    void unload();
    bool loaded() const { return program_ != nullptr; }
    const Program* program() const { return program_; }

    // Resets data memory to its start values (cold restart) and clears %I/%Q/%M.
    void reset();

    // Runs the startup OB (if any).
    Result startup(uint32_t now);
    // Runs one scan of the main OB, or resumes it after WAIT.
    Result scan(uint32_t now);
    bool waiting() const { return waitingUntil_ != 0 || suspended_; }

    // Maximum execution time of a scan before the watchdog trips (0 = none).
    void setWatchdog(uint32_t ms) { watchdogMs_ = ms; }

    const Fault& fault() const { return fault_; }

    // Memory areas (Area::D, I, Q, M); nullptr for other areas.
    uint8_t* area(uint8_t area, uint32_t& size);

private:
    Result run(uint16_t function, uint32_t now);
    Result exec();
    Result trap(uint8_t code);

    bool enter(uint16_t function, uint32_t instanceBase);
    uint8_t* resolve(uint8_t area, uint32_t offset, uint32_t size);
    uint8_t* resolvePtr(int64_t ptr, uint32_t size);
    bool loadValue(uint8_t type, const uint8_t* p, Cell& out);
    void storeValue(uint8_t type, uint8_t* p, const Cell& v);
    bool std(uint8_t fn, uint8_t argc);
    bool sys(uint8_t fn, uint8_t argc, bool& suspend);
    bool library(uint8_t block, uint8_t* inst);
    // STRING helpers: header (max, len) then characters
    uint8_t* str(int64_t ptr);

    bool push(Cell c) {
        if (sp_ >= VPLC_MAX_STACK) return false;
        stack_[sp_++] = c;
        return true;
    }

    struct Frame {
        uint32_t returnPc;
        uint32_t instanceBase;
        uint16_t function;
    };

    const Program* program_ = nullptr;
    VmHost* host_ = nullptr;
    uint8_t* d_ = nullptr;
    uint8_t* i_ = nullptr;
    uint8_t* q_ = nullptr;
    uint8_t* m_ = nullptr;

    Cell stack_[VPLC_MAX_STACK];
    uint16_t sp_ = 0;
    Frame frames_[VPLC_MAX_CALL_DEPTH];
    uint8_t depth_ = 0;
    uint32_t pc_ = 0;
    uint32_t ib_ = 0;           // instance base of the running FB
    uint16_t function_ = 0;
    uint32_t now_ = 0;
    uint32_t scanStart_ = 0;  // watchdog clock at the start of the scan
    uint32_t watchdogMs_ = 0;
    uint32_t waitingUntil_ = 0;
    bool suspended_ = false;
    uint16_t backJumps_ = 0;
    Fault fault_;
};

}  // namespace vplc
