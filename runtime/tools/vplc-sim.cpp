// VirtualPLC simulator: runs the CPU core with a virtual clock, driven by
// text commands on stdin (one per line). Used by the conformance tests and
// handy to try a program without hardware.
//
//   load <file>                     download a program image (through the protocol)
//   start [cold] | stop
//   scan [count] [ms]               advance the clock by ms (default: cycle time) and run due scans
//   read <D|I|Q|M> <offset> <len>   -> OK <hex>
//   write <D|I|Q|M> <offset> <hex>
//   bit <D|I|Q|M> <byte> <bit> <0|1>
//   force <I|Q> <byte> <bit> <0|1|2>   (2 = remove)
//   state | info | logs [from]      -> OK <json>
//   quit
#include <stdio.h>
#include <time.h>
#include <stdlib.h>
#include <string.h>

#include <string>
#include <vector>

#include "../core/bytes.h"
#include "../core/cpu.h"
#include "../core/isa.h"

using namespace vplc;

namespace {

class SimPlatform : public Platform {
public:
    uint32_t clock = 0;
    std::vector<uint8_t> stored;
    std::vector<uint8_t> outputs;

    const char* deviceType() override { return "simulator"; }
    uint32_t millis() override { return clock; }
    uint32_t watchdogMillis() override {
        timespec ts;
        clock_gettime(CLOCK_MONOTONIC, &ts);
        return uint32_t(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
    }
    uint32_t micros() override { return clock * 1000; }
    void log(const char* message) override { fprintf(stderr, "[plc] %s\n", message); }
    bool moduleOk(uint16_t) override { return true; }
    bool storeProgram(const uint8_t* image, size_t length) override {
        stored.assign(image, image + length);
        return true;
    }
    size_t loadProgram(uint8_t* buf, size_t capacity) override {
        if (stored.empty() || stored.size() > capacity) return 0;
        memcpy(buf, stored.data(), stored.size());
        return stored.size();
    }
    uint16_t configureIo(const Program&) override { return 0; }
    void readInputs(uint8_t*, uint32_t) override {}  // inputs are written by the test
    void writeOutputs(const uint8_t* image, uint32_t size) override { outputs.assign(image, image + size); }
};

uint8_t areaCode(const char* s) {
    switch (s[0]) {
        case 'D': return uint8_t(Area::D);
        case 'I': return uint8_t(Area::I);
        case 'Q': return uint8_t(Area::Q);
        case 'M': return uint8_t(Area::M);
        default: return 0xFF;
    }
}

std::vector<uint8_t> fromHex(const char* hex) {
    std::vector<uint8_t> out;
    for (size_t i = 0; hex[i] && hex[i + 1]; i += 2) {
        char b[3] = {hex[i], hex[i + 1], 0};
        out.push_back(uint8_t(strtoul(b, nullptr, 16)));
    }
    return out;
}

}  // namespace

static SimPlatform platform;
static uint8_t programBuffer[1 << 20];
static uint8_t arena[4 << 20];
static uint8_t response[VPLC_MAX_PAYLOAD + 16];

static bool request(Cpu& cpu, Command cmd, const std::vector<uint8_t>& payload, std::string& text) {
    Session session;
    session.authenticated = true;
    size_t n = cpu.handle(session, uint8_t(cmd), 1, payload.data(), uint32_t(payload.size()), response);
    uint32_t len = rd32le(response + 5);
    text.assign(reinterpret_cast<char*>(response + 9), len);
    (void)n;
    return response[4] == uint8_t(Status::ST_OK);
}

int main(int argc, char** argv) {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    Cpu cpu(platform, programBuffer, sizeof programBuffer, arena, sizeof arena);
    cpu.setWatchdog(argc > 1 ? uint32_t(atoi(argv[1])) : 0);  // virtual clock: no watchdog by default

    char line[1 << 16];
    while (fgets(line, sizeof line, stdin)) {
        line[strcspn(line, "\r\n")] = 0;
        char* argv2[8] = {nullptr};
        int n = 0;
        for (char* tok = strtok(line, " "); tok && n < 8; tok = strtok(nullptr, " ")) argv2[n++] = tok;
        if (n == 0) continue;
        std::string cmd = argv2[0], text;

        if (cmd == "quit") break;
        if (cmd == "load" && n >= 2) {
            FILE* f = fopen(argv2[1], "rb");
            if (!f) { printf("ERR cannot open %s\n", argv2[1]); continue; }
            std::vector<uint8_t> image;
            int c;
            while ((c = fgetc(f)) != EOF) image.push_back(uint8_t(c));
            fclose(f);
            std::vector<uint8_t> begin(8);
            wr32le(begin.data(), uint32_t(image.size()));
            wr32le(begin.data() + 4, crc32(image.data(), uint32_t(image.size())));
            bool ok = request(cpu, Command::CMD_DOWNLOAD_BEGIN, begin, text);
            for (size_t off = 0; ok && off < image.size(); off += 1000) {
                size_t len = image.size() - off < 1000 ? image.size() - off : 1000;
                std::vector<uint8_t> chunk(4 + len);
                wr32le(chunk.data(), uint32_t(off));
                memcpy(chunk.data() + 4, image.data() + off, len);
                ok = request(cpu, Command::CMD_DOWNLOAD_CHUNK, chunk, text);
            }
            if (ok) ok = request(cpu, Command::CMD_DOWNLOAD_END, {}, text);
            printf(ok ? "OK\n" : "ERR %s\n", text.c_str());
        } else if (cmd == "start") {
            bool ok = request(cpu, Command::CMD_START, {uint8_t(n > 1 && strcmp(argv2[1], "cold") == 0)}, text);
            printf(ok ? "OK\n" : "ERR %s\n", text.c_str());
        } else if (cmd == "stop") {
            request(cpu, Command::CMD_STOP, {}, text);
            printf("OK\n");
        } else if (cmd == "scan") {
            int count = n > 1 ? atoi(argv2[1]) : 1;
            uint32_t dt = n > 2 ? uint32_t(atoi(argv2[2])) : cpu.program().cycleMs;
            for (int k = 0; k < count; k++) {
                platform.clock += dt;
                cpu.loop();
            }
            printf("OK\n");
        } else if ((cmd == "read" || cmd == "write" || cmd == "bit") && n >= 4) {
            uint8_t area = areaCode(argv2[1]);
            uint32_t offset = uint32_t(strtoul(argv2[2], nullptr, 10));
            std::vector<uint8_t> p(1, area);
            p.resize(5);
            wr32le(p.data() + 1, offset);
            bool ok;
            if (cmd == "read") {
                p.resize(7);
                wr16le(p.data() + 5, uint16_t(atoi(argv2[3])));
                ok = request(cpu, Command::CMD_READ, p, text);
                if (ok) {
                    printf("OK ");
                    for (unsigned char b : text) printf("%02x", b);
                    printf("\n");
                    continue;
                }
            } else if (cmd == "write") {
                std::vector<uint8_t> data = fromHex(argv2[3]);
                p.push_back(0xFF);
                p.resize(8);
                wr16le(p.data() + 6, uint16_t(data.size()));
                p.insert(p.end(), data.begin(), data.end());
                ok = request(cpu, Command::CMD_WRITE, p, text);
            } else {
                p.push_back(uint8_t(atoi(argv2[3])));
                p.resize(8);
                wr16le(p.data() + 6, 1);
                p.push_back(uint8_t(n > 4 ? atoi(argv2[4]) : 1));
                ok = request(cpu, Command::CMD_WRITE, p, text);
            }
            printf(ok ? "OK\n" : "ERR %s\n", text.c_str());
        } else if (cmd == "force" && n >= 5) {
            std::vector<uint8_t> p(7);
            p[0] = areaCode(argv2[1]);
            wr32le(p.data() + 1, uint32_t(atoi(argv2[2])));
            p[5] = uint8_t(atoi(argv2[3]));
            p[6] = uint8_t(atoi(argv2[4]));
            bool ok = request(cpu, Command::CMD_FORCE, p, text);
            printf(ok ? "OK\n" : "ERR %s\n", text.c_str());
        } else if (cmd == "state" || cmd == "info" || cmd == "logs") {
            std::vector<uint8_t> p;
            if (cmd == "logs") {
                p.resize(4);
                wr32le(p.data(), uint32_t(n > 1 ? atoi(argv2[1]) : 0));
            }
            Command c = cmd == "state" ? Command::CMD_STATE : cmd == "info" ? Command::CMD_INFO : Command::CMD_LOGS;
            bool ok = request(cpu, c, p, text);
            printf(ok ? "OK %s\n" : "ERR %s\n", text.c_str());
        } else {
            printf("ERR unknown command\n");
        }
    }
    return 0;
}
