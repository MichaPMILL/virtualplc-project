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
