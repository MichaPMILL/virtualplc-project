// Interface between the portable CPU core and a hardware platform
// (Linux, ESP32, Arduino...).
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#include "program.h"
#include "vm.h"

namespace vplc {

class Platform : public VmHost {
public:
    // "linux", "esp32", "arduino-mega", ...
    virtual const char* deviceType() = 0;
    virtual uint32_t micros() = 0;

    // Non-volatile storage of the program image
    virtual bool storeProgram(const uint8_t* image, size_t length) = 0;
    // Loads the stored image into buf; returns its length (0 = none).
    virtual size_t loadProgram(uint8_t* buf, size_t capacity) = 0;

    // I/O modules of a newly loaded program (IOCONF section). Returns the number
    // of modules; unsupported modules are reported through log().
    virtual uint16_t configureIo(const Program& program) = 0;
    // Called at the start of each scan: fill the %I image.
    virtual void readInputs(uint8_t* image, uint32_t size) = 0;
    // Called at the end of each scan (and with an all-zero image in STOP/FAULT).
    virtual void writeOutputs(const uint8_t* image, uint32_t size) = 0;
    // Messages of platform threads (I/O, PROFINET...) for the diagnostic buffer: the CPU
    // calls this from its own thread and records each message.
    virtual void drainMessages(void (*record)(void* ctx, const char* message), void* ctx) { (void)record; (void)ctx; }
    // Diagnostic text of a module for the Studio (active diagnoses, one per line); 0 = none
    virtual size_t moduleDiagnostics(uint16_t index, char* out, size_t cap) { (void)index; (void)out; (void)cap; return 0; }

    // --- Users and audit trail. Without users, the CPU password (if any) gives the ADMIN role.
    virtual bool hasUsers() { return false; }
    // Role of the user (0 = refused). Must be fast (called by the CPU thread).
    virtual uint8_t authenticate(const char* user, const char* password) { (void)user; (void)password; return 0; }
    // USERS command: request in, JSON out; session user and role for the permissions. nullptr on success, else an error
    virtual const char* users(const uint8_t* request, uint32_t length, const char* user, uint8_t role, char* out, size_t cap, size_t& written) {
        (void)request; (void)length; (void)user; (void)role; (void)out; (void)cap;
        written = 0;
        return "user management is not supported by this CPU";
    }
    // Audit trail: who did what (append only)
    virtual void audit(const char* user, const char* peer, const char* action, const char* detail) { (void)user; (void)peer; (void)action; (void)detail; }
    virtual size_t auditRead(uint32_t from, uint16_t count, char* out, size_t cap) {
        (void)from; (void)count;
        return cap > 2 ? size_t(snprintf(out, cap, "[]")) : 0;
    }

    // --- Traceability (data logs). Platforms without storage keep the defaults.
    // Data logs of a newly loaded program (DATALOGS section): false = not supported (reported)
    virtual bool configureDataLogs(const Program& program) { (void)program; return false; }
    // One record of data log `log`: the column values as in memory (bits: one byte 0/1),
    // `timeNs` = date and time of the capture (0 if the CPU has no clock). Called by the CPU
    // thread: must not block. False when the record cannot be kept (queue full).
    virtual bool dataLog(uint16_t log, int64_t timeNs, const uint8_t* values, uint32_t length) {
        (void)log; (void)timeNs; (void)values; (void)length;
        return false;
    }
    // Latest records (JSON: columns, rows, forwarding state), `before` = record id (0 = newest);
    // full: rows with the time in ns and the whole hash chain (traceability certificates)
    virtual size_t dataLogRead(uint16_t log, uint16_t count, uint64_t before, bool full, char* out, size_t cap) {
        (void)log; (void)count; (void)before; (void)full;
        return cap > 2 ? size_t(snprintf(out, cap, "{\"error\":\"data logs are not supported by this CPU\"}")) : 0;
    }
    // Credentials of a database (key = "kind://user@host:port/db"); nullptr on success
    virtual const char* setSecret(const char* key, const char* value) { (void)key; (void)value; return "not supported by this CPU"; }
    // Connects to the database of data log `log` and reports the result (JSON)
    virtual size_t dataLogTest(uint16_t log, char* out, size_t cap) { return dataLogRead(log, 0, 0, false, out, cap); }
};

}  // namespace vplc
