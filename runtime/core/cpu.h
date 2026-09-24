// The PLC CPU: owns the loaded program, runs the scan cycle and serves the
// device protocol. Portable: all buffers are provided by the platform.
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "config.h"
#include "platform.h"
#include "program.h"
#include "vm.h"

namespace vplc {

// Roles of the users of the CPU, as the protection levels of the usual engineering tools:
// VIEWER = read access (state, values, logs), OPERATOR = HMI access (+ modify values,
// RUN / STOP), ENGINEER = full access (+ download, force, credentials), ADMIN = + users.
enum class Role : uint8_t { NONE = 0, VIEWER = 1, OPERATOR = 2, ENGINEER = 3, ADMIN = 4 };
const char* roleName(uint8_t role);

// Per-connection protocol state.
struct Session {
    bool authenticated = false;
    uint8_t role = 0;
    char user[33] = {0};
    // Remote address (set by the platform: "192.168.0.20", "serial"...), for the audit trail
    char peer[48] = {0};
};

class Cpu {
public:
    Cpu(Platform& platform, uint8_t* programBuffer, size_t programCapacity, uint8_t* arena, size_t arenaCapacity);

    void setName(const char* name);
    void setPassword(const char* password);  // nullptr / "" = no authentication
    // Maximum duration of a scan before the CPU goes to FAULT.
    void setWatchdog(uint32_t ms) { watchdogMs_ = ms; }

    // Loads the stored program and starts it (like a PLC powered on in RUN).
    void begin(bool autoStart = true);

    // Runs a scan when due. Returns the number of milliseconds until the next scan.
    uint32_t loop();

    // Processes a request frame; writes the response frame into out (capacity >= VPLC_MAX_PAYLOAD + 13).
    size_t handle(Session& session, uint8_t command, uint8_t sequence, const uint8_t* payload, uint32_t length, uint8_t* out);

    uint8_t state() const { return state_; }
    const Program& program() const { return program_; }
    Vm& vm() { return vm_; }
    void log(const char* message);
    // Diagnostic buffer only (the platform already printed the message)
    void record(const char* message);

    // Direct control (also used by the protocol)
    const char* start(bool cold);
    void stop();

private:
    const char* loadImage(size_t length);
    void safeOutputs();
    void applyForces(uint8_t area, uint8_t* image, uint32_t size);
    size_t info(char* out, size_t cap);
    size_t stateJson(char* out, size_t cap);
    size_t logsJson(uint32_t from, char* out, size_t cap);

    // Forwards the VM's services to the platform, and program LOG() messages to the CPU log.
    struct Host : VmHost {
        Cpu* cpu = nullptr;
        uint32_t millis() override { return cpu->platform_.millis(); }
        uint32_t watchdogMillis() override { return cpu->platform_.watchdogMillis(); }
        void log(const char* message) override { cpu->log(message); }
        bool moduleOk(uint16_t index) override { return cpu->platform_.moduleOk(index); }
        bool moduleDiag(uint16_t index) override { return cpu->platform_.moduleDiag(index); }
        bool alarm(uint16_t module, uint16_t slot, uint16_t kind, uint32_t code) override { return cpu->platform_.alarm(module, slot, kind, code); }
        bool clock(bool local, int64_t& ns) override { return cpu->platform_.clock(local, ns); }
        bool dataLogRequest(uint16_t log) override { return cpu->requestDataLog(log); }
    };

    // Traceability: triggers of the data logs of the program
    void setupDataLogs();
    bool requestDataLog(uint16_t log);
    void processDataLogs(uint32_t now);
    struct LogTrigger {
        uint8_t kind = 0, area = 0, bit = 0xFF;
        uint32_t offset = 0, periodMs = 0, nextDue = 0;
        bool lastEdge = false, pending = false;
    };
    LogTrigger dataLogs_[VPLC_MAX_DATALOGS > 0 ? VPLC_MAX_DATALOGS : 1];
    uint16_t logCount_ = 0;
    uint32_t logDropped_ = 0;
    uint8_t record_[VPLC_MAX_DATALOGS > 0 ? VPLC_DATALOG_RECORD : 1];

    Platform& platform_;
    Host host_;
    uint8_t* image_;
    size_t imageCapacity_;
    uint8_t* arena_;
    size_t arenaCapacity_;
    Program program_;
    Vm vm_;
    uint8_t state_;
    char name_[32] = "PLC_1";
    char password_[33] = {0};
    // Authentication: required role of a command, lockout after repeated failures
    bool authRequired();
    static uint8_t requiredRole(uint8_t command);
    void auditEvent(const Session& s, const char* action, const char* detail);
    uint8_t authFailures_ = 0;
    uint32_t authBlockedUntil_ = 0;
    bool authBlocked_ = false;
    uint32_t watchdogMs_ = 1000;
    uint16_t modules_ = 0;

    // scan statistics
    uint32_t lastScan_ = 0;
    uint32_t scans_ = 0;
    uint32_t scanUs_ = 0;
    uint32_t maxScanUs_ = 0;

    // download
    bool downloading_ = false;
    uint32_t downloadSize_ = 0, downloadCrc_ = 0, received_ = 0;

    // forces
    struct Force { uint8_t area; uint16_t byte; uint8_t bit; uint8_t value; };
    Force forces_[VPLC_MAX_FORCES];
    uint8_t forceCount_ = 0;

    // log ring buffer
    struct LogEntry { uint32_t seq; uint32_t time; char text[VPLC_LOG_LENGTH]; };
    LogEntry logs_[VPLC_LOG_ENTRIES];
    uint32_t logSeq_ = 0;
};

const char* stateName(uint8_t state);

}  // namespace vplc
