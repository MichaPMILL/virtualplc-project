// VirtualPLC CPU compiled to WebAssembly: the simulated CPU of the Studio ("simulation mode").
// The same portable core as the Linux CPU and the microcontroller firmware; the host (the
// Studio backend, in JavaScript) provides the clocks and exchanges protocol bytes:
//
//   imports  env.host_now_ms() -> f64     monotonic clock (scan cycle, watchdog)
//            env.host_date_ms() -> f64    date and time (RD_SYS_T / RD_LOC_T)
//            env.host_tz_min() -> i32     local time offset in minutes
//            env.host_log(ptr)            program / CPU messages (NUL-terminated UTF-8)
//   exports  vplc_init(maxProgram, maxData) -> 1 when ready
//            vplc_in() -> pointer of the input buffer (VPLC_WASM_IO bytes)
//            vplc_feed(len)               protocol bytes written at vplc_in()
//            vplc_out() / vplc_out_len() / vplc_out_clear()   response bytes
//            vplc_loop() -> ms            runs the due scans; delay until the next one
//
// Build: runtime/wasm/build.sh (clang --target=wasm32-wasi, wasi-libc)
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "../core/cpu.h"
#include "../core/isa.h"
#include "../core/protocol.h"
#include "../core/bytes.h"

#include <time.h>

#define WASM_IMPORT(name) __attribute__((import_module("env"), import_name(#name)))
#define WASM_EXPORT(name) extern "C" __attribute__((export_name(#name)))

extern "C" {
WASM_IMPORT(host_now_ms) double host_now_ms();
WASM_IMPORT(host_date_ms) double host_date_ms();
WASM_IMPORT(host_tz_min) int32_t host_tz_min();
WASM_IMPORT(host_log) void host_log(const char* message);
}

using namespace vplc;

// No C++ runtime library: placement new and the pure virtual handler are provided here
inline void* operator new(size_t, void* p) noexcept { return p; }
extern "C" void __cxa_pure_virtual() { abort(); }
void operator delete(void* p) noexcept { free(p); }
void operator delete(void* p, size_t) noexcept { free(p); }

namespace {

constexpr size_t VPLC_WASM_IO = 64 * 1024;
constexpr size_t OUT_CAPACITY = 256 * 1024;

class WasmPlatform : public Platform {
public:
    uint8_t* stored = nullptr;
    size_t storedLength = 0;
    size_t storedCapacity = 0;

    const char* deviceType() override { return "simulator"; }
    uint32_t millis() override { return uint32_t(uint64_t(host_now_ms())); }
    uint32_t micros() override { return uint32_t(uint64_t(host_now_ms() * 1000.0)); }
    uint32_t watchdogMillis() override { return millis(); }
    bool clock(bool local, int64_t& ns) override {
        double ms = host_date_ms() + (local ? double(host_tz_min()) * 60000.0 : 0.0);
        ns = int64_t(ms) * 1000000LL;
        return true;
    }
    void log(const char* message) override { host_log(message); }
    bool moduleOk(uint16_t) override { return true; }
    // The program stays in memory while the simulation runs
    bool storeProgram(const uint8_t* image, size_t length) override {
        if (length > storedCapacity) return false;
        memcpy(stored, image, length);
        storedLength = length;
        return true;
    }
    size_t loadProgram(uint8_t* buf, size_t capacity) override {
        if (storedLength == 0 || storedLength > capacity) return 0;
        memcpy(buf, stored, storedLength);
        return storedLength;
    }
    // Simulated I/O: modules are accepted and do nothing; %I is written by the Studio
    uint16_t configureIo(const Program& program) override {
        IoModuleReader reader(program.ioconf);
        static IoModuleInfo info;
        uint16_t n = 0;
        while (reader.next(info)) n++;
        return n;
    }
    void readInputs(uint8_t*, uint32_t) override {}
    void writeOutputs(const uint8_t*, uint32_t) override {}

    // Data logs: the latest records stay in memory (no database, no signature in simulation)
    static constexpr uint16_t LOG_RECORDS = 200;
    struct SimLog {
        const Program* program = nullptr;
        uint16_t index = 0;
        uint32_t recordSize = 0;
        uint8_t* ring = nullptr;      // LOG_RECORDS * (8 + recordSize)
        uint32_t count = 0;           // records written (ids 1..count)
    };
    SimLog logs[VPLC_MAX_DATALOGS];
    uint16_t logCount = 0;
    const Program* program = nullptr;

    bool configureDataLogs(const Program& p) override {
        for (uint16_t k = 0; k < logCount; k++) free(logs[k].ring);
        logCount = 0;
        program = &p;
        DataLogReader reader(p.datalogs);
        DataLogInfo info;
        while (logCount < VPLC_MAX_DATALOGS && reader.next(info)) {
            SimLog& l = logs[logCount];
            l = SimLog();
            l.index = logCount;
            l.recordSize = info.recordSize();
            l.ring = static_cast<uint8_t*>(malloc(size_t(LOG_RECORDS) * (8 + l.recordSize)));
            if (!l.ring) return false;
            logCount++;
        }
        return true;
    }

    bool dataLog(uint16_t log, int64_t timeNs, const uint8_t* values, uint32_t length) override {
        if (log >= logCount || length != logs[log].recordSize) return false;
        SimLog& l = logs[log];
        uint8_t* slot = l.ring + size_t(l.count % LOG_RECORDS) * (8 + l.recordSize);
        memcpy(slot, &timeNs, 8);
        memcpy(slot + 8, values, length);
        l.count++;
        return true;
    }

    size_t dataLogRead(uint16_t log, uint16_t count, uint64_t before, bool full, char* out, size_t cap) override;
};

WasmPlatform platform;
Cpu* cpu = nullptr;
alignas(Cpu) uint8_t cpuStorage[sizeof(Cpu)];
Session session;
FrameParser parserStorage;
FrameParser* parser = &parserStorage;
uint8_t input[VPLC_WASM_IO];
uint8_t* out = nullptr;
size_t outLength = 0;
uint8_t response[VPLC_MAX_PAYLOAD + 16];

}  // namespace

WASM_EXPORT(vplc_init) int vplc_init(uint32_t maxProgram, uint32_t maxData) {
    if (cpu) return 1;
    uint8_t* programBuffer = static_cast<uint8_t*>(malloc(maxProgram));
    uint8_t* arena = static_cast<uint8_t*>(malloc(maxData));
    platform.stored = static_cast<uint8_t*>(malloc(maxProgram));
    platform.storedCapacity = maxProgram;
    out = static_cast<uint8_t*>(malloc(OUT_CAPACITY));
    if (!programBuffer || !arena || !platform.stored || !out) return 0;
    cpu = new (cpuStorage) Cpu(platform, programBuffer, maxProgram, arena, maxData);
    cpu->setName("PLCSIM");
    cpu->setWatchdog(1000);
    cpu->begin(false);
    return 1;
}

WASM_EXPORT(vplc_in) uint8_t* vplc_in() { return input; }
WASM_EXPORT(vplc_out) uint8_t* vplc_out() { return out; }
WASM_EXPORT(vplc_out_len) uint32_t vplc_out_len() { return uint32_t(outLength); }
WASM_EXPORT(vplc_out_clear) void vplc_out_clear() { outLength = 0; }

WASM_EXPORT(vplc_feed) void vplc_feed(uint32_t length) {
    if (!cpu) return;
    for (uint32_t i = 0; i < length && i < VPLC_WASM_IO; i++) {
        FrameParser::Result r = parser->feed(input[i]);
        if (r == FrameParser::ERROR) {
            parser->reset();
        } else if (r == FrameParser::FRAME) {
            size_t n = cpu->handle(session, parser->command(), parser->sequence(), parser->payload(), parser->length(), response);
            if (outLength + n <= OUT_CAPACITY) {
                memcpy(out + outLength, response, n);
                outLength += n;
            }
        }
    }
}

WASM_EXPORT(vplc_loop) uint32_t vplc_loop() { return cpu ? cpu->loop() : 100; }

// ---------------------------------------------------------------------------
// Data logs of the simulated CPU (JSON as the Linux CPU, see DataLogger::read)
// ---------------------------------------------------------------------------

namespace {
const char* kindOf(const DataLogColumn& c) {
    if (c.bit != 0xFF || c.type == uint8_t(VmType::T_BOOL)) return "bool";
    if (c.type == 0x20) return "text";
    if (c.type == uint8_t(VmType::T_F32) || c.type == uint8_t(VmType::T_F64)) return "real";
    return "int";
}

void jsonValue(JsonWriter& j, const DataLogColumn& c, const uint8_t* b) {
    char num[40];
    if (c.bit != 0xFF || c.type == uint8_t(VmType::T_BOOL)) { j.raw(b[0] ? "true" : "false"); return; }
    if (c.type == 0x20) {
        char text[256];
        uint8_t len = c.size >= 2 ? b[1] : 0;
        if (len > c.size - 2) len = uint8_t(c.size - 2);
        memcpy(text, b + 2, len);
        text[len] = 0;
        j.str(text);
        return;
    }
    switch (VmType(c.type)) {
        case VmType::T_F32: { uint32_t bits = uint32_t(rdbe(b, 4)); float f; memcpy(&f, &bits, 4); snprintf(num, sizeof num, "%.9g", double(f)); j.raw(num); return; }
        case VmType::T_F64: { uint64_t bits = rdbe(b, 8); double d; memcpy(&d, &bits, 8); snprintf(num, sizeof num, "%.17g", d); j.raw(num); return; }
        case VmType::T_U8: j.num(b[0]); return;
        case VmType::T_I8: j.num(int8_t(b[0])); return;
        case VmType::T_U16: j.num(uint16_t(rdbe(b, 2))); return;
        case VmType::T_I16: j.num(int16_t(uint16_t(rdbe(b, 2)))); return;
        case VmType::T_U32: j.num(uint32_t(rdbe(b, 4))); return;
        default:
            if (c.type == 0x21 || c.type == uint8_t(VmType::T_I32)) j.num(int32_t(uint32_t(rdbe(b, 4))));
            else j.num(int64_t(rdbe(b, 8)));
    }
}
}  // namespace

size_t WasmPlatform::dataLogRead(uint16_t log, uint16_t count, uint64_t before, bool full, char* out, size_t cap) {
    JsonWriter j(out, cap);
    if (!program || log >= logCount) {
        j.open('{').key("error").str("unknown data log").close('}');
        return j.length();
    }
    DataLogReader reader(program->datalogs);
    DataLogInfo info;
    for (uint16_t k = 0; k <= log; k++) reader.next(info);
    SimLog& l = logs[log];
    j.open('{');
    j.key("name").str(info.name);
    j.key("plc").str("PLCSIM");
    j.key("epoch").num(0);
    j.key("records").num(l.count);
    j.key("pending").num(0);
    j.key("simulation").raw("true");
    if (info.dbKind != DataLogInfo::NONE) j.key("destination").str("simulation: records are not sent to the database");
    j.key("columns").open('[');
    uint8_t pos = 0;
    const uint8_t* cursor = nullptr;
    DataLogColumn c;
    while (info.column(pos, cursor, c)) j.str(c.name);
    j.close(']');
    j.key("kinds").open('[');
    pos = 0;
    while (info.column(pos, cursor, c)) j.str(kindOf(c));
    j.close(']');
    j.key("rows").open('[');
    uint64_t last = before && before <= l.count ? before - 1 : l.count;
    uint64_t oldest = l.count > LOG_RECORDS ? l.count - LOG_RECORDS + 1 : 1;
    for (uint64_t id = last; id >= oldest && id > 0 && count > 0; id--, count--) {
        if (j.length() + 8 * size_t(l.recordSize) + 128 > cap) break;  // keep the JSON complete
        const uint8_t* slot = l.ring + size_t((id - 1) % LOG_RECORDS) * (8 + l.recordSize);
        int64_t ns;
        memcpy(&ns, slot, 8);
        j.open('[');
        j.num(int64_t(id));
        if (full) {
            char t[24];
            snprintf(t, sizeof t, "%lld", static_cast<long long>(ns));
            j.str(t);
        } else {
            // ISO date, UTC
            time_t secs = time_t(ns / 1000000000LL);
            struct tm tm;
            gmtime_r(&secs, &tm);
            char t[40];
            snprintf(t, sizeof t, "%04d-%02d-%02d %02d:%02d:%02d.%03dZ", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec,
                     int((ns / 1000000) % 1000));
            j.str(t);
        }
        const uint8_t* v = slot + 8;
        pos = 0;
        while (info.column(pos, cursor, c)) {
            jsonValue(j, c, v);
            v += c.bit != 0xFF ? 1 : c.size;
        }
        j.str("");
        j.raw("true");
        j.close(']');
    }
    j.close(']');
    j.close('}');
    return j.length();
}
