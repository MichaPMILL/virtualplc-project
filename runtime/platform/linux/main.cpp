// VirtualPLC CPU for Linux / Raspberry Pi.
//
//   vplc-cpu [--data DIR] [--listen ADDR] [--port 20105] [--name PLC_1] [--password SECRET]
//            [--modbus-port 5020] [--gpio-chip /dev/gpiochip0] [--watchdog-ms 1000]
//            [--max-program BYTES] [--max-data BYTES] [--stopped]
//
// Environment variables VPLC_PASSWORD, VPLC_DATA_DIR... override nothing: the
// password should come from a file readable by the service only (--password-file).
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include <memory>
#include <string>
#include <vector>

#include "bytes.h"
#include "cpu.h"
#include "isa.h"
#include "linux_platform.h"
#include "modbus.h"
#include "protocol.h"

using namespace vplc;

namespace {

volatile sig_atomic_t stopRequested = 0;

void onSignal(int) { stopRequested = 1; }

struct Options {
    std::string dataDir = "/var/lib/virtualplc";
    std::string listen = "0.0.0.0";
    int port = PROTOCOL_PORT;
    int modbusPort = 5020;
    std::string name = "PLC_1";
    std::string password;
    std::string gpioChip = "/dev/gpiochip0";
    uint32_t watchdogMs = 1000;
    size_t maxProgram = 1 << 20;
    size_t maxData = 8 << 20;
    bool stopped = false;
};

void usage() {
    printf(
        "VirtualPLC CPU %s\n\n"
        "  --data DIR            program storage (default /var/lib/virtualplc)\n"
        "  --listen ADDR         bind address (default 0.0.0.0)\n"
        "  --port N              device protocol port (default %u)\n"
        "  --modbus-port N       Modbus TCP server for HMIs, 0 = disabled (default 5020)\n"
        "  --name NAME           device name shown in the Studio\n"
        "  --password-file FILE  require a password (first line of FILE)\n"
        "  --gpio-chip DEV       GPIO character device (default /dev/gpiochip0)\n"
        "  --watchdog-ms N       maximum scan time before FAULT (default 1000)\n"
        "  --max-program BYTES   maximum program size (default 1 MiB)\n"
        "  --max-data BYTES      maximum data memory (default 8 MiB)\n"
        "  --stopped             do not start the stored program automatically\n",
        VPLC_FIRMWARE_VERSION, unsigned(PROTOCOL_PORT));
}

bool parse(int argc, char** argv, Options& o) {
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        auto next = [&]() -> const char* { return i + 1 < argc ? argv[++i] : nullptr; };
        const char* v = nullptr;
        if (a == "--stopped") { o.stopped = true; continue; }
        if (a == "--help" || a == "-h") { usage(); exit(0); }
        if (!(v = next())) { fprintf(stderr, "Missing value for %s\n", a.c_str()); return false; }
        if (a == "--data") o.dataDir = v;
        else if (a == "--listen") o.listen = v;
        else if (a == "--port") o.port = atoi(v);
        else if (a == "--modbus-port") o.modbusPort = atoi(v);
        else if (a == "--name") o.name = v;
        else if (a == "--gpio-chip") o.gpioChip = v;
        else if (a == "--watchdog-ms") o.watchdogMs = uint32_t(atoi(v));
        else if (a == "--max-program") o.maxProgram = size_t(atoll(v));
        else if (a == "--max-data") o.maxData = size_t(atoll(v));
        else if (a == "--password-file") {
            FILE* f = fopen(v, "r");
            char line[64] = {0};
            if (!f || !fgets(line, sizeof line, f)) { fprintf(stderr, "Cannot read %s\n", v); if (f) fclose(f); return false; }
            fclose(f);
            line[strcspn(line, "\r\n")] = 0;
            o.password = line;
        } else {
            fprintf(stderr, "Unknown option %s\n", a.c_str());
            return false;
        }
    }
    return true;
}

int listenOn(const std::string& addr, int port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    sockaddr_in sa{};
    sa.sin_family = AF_INET;
    sa.sin_port = htons(uint16_t(port));
    if (inet_pton(AF_INET, addr.c_str(), &sa.sin_addr) != 1 || bind(fd, reinterpret_cast<sockaddr*>(&sa), sizeof sa) < 0 ||
        listen(fd, 8) < 0) {
        close(fd);
        return -1;
    }
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    return fd;
}

bool sendAll(int fd, const uint8_t* data, size_t len) {
    while (len) {
        ssize_t n = send(fd, data, len, MSG_NOSIGNAL);
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            pollfd p{fd, POLLOUT, 0};
            if (poll(&p, 1, 1000) <= 0) return false;
            continue;
        }
        if (n <= 0) return false;
        data += n;
        len -= size_t(n);
    }
    return true;
}

struct Client {
    int fd;
    bool modbus;  // Modbus HMI connection or device protocol
    Session session;
    std::unique_ptr<FrameParser> parser;
    std::vector<uint8_t> buffer;  // Modbus receive buffer
};

constexpr size_t MAX_CLIENTS = 16;

}  // namespace

int main(int argc, char** argv) {
    Options opt;
    if (!parse(argc, argv, opt)) return 2;

    signal(SIGTERM, onSignal);
    signal(SIGINT, onSignal);
    signal(SIGPIPE, SIG_IGN);

    std::vector<uint8_t> programBuffer(opt.maxProgram), arena(opt.maxData);
    static uint8_t response[VPLC_MAX_PAYLOAD + 16];

    LinuxPlatform platform(opt.dataDir, opt.gpioChip);
    Cpu cpu(platform, programBuffer.data(), programBuffer.size(), arena.data(), arena.size());
    cpu.setName(opt.name.c_str());
    cpu.setPassword(opt.password.c_str());
    cpu.setWatchdog(opt.watchdogMs);

    int server = listenOn(opt.listen, opt.port);
    if (server < 0) {
        fprintf(stderr, "Cannot listen on %s:%d: %s\n", opt.listen.c_str(), opt.port, strerror(errno));
        return 1;
    }
    int modbusServer = opt.modbusPort > 0 ? listenOn(opt.listen, opt.modbusPort) : -1;
    if (opt.modbusPort > 0 && modbusServer < 0) {
        fprintf(stderr, "Cannot listen on Modbus port %d: %s\n", opt.modbusPort, strerror(errno));
        return 1;
    }
    char msg[160];
    snprintf(msg, sizeof msg, "VirtualPLC CPU %s '%s' listening on %s:%d%s%s", VPLC_FIRMWARE_VERSION, opt.name.c_str(),
             opt.listen.c_str(), opt.port, modbusServer >= 0 ? ", Modbus HMI server on port " : "",
             modbusServer >= 0 ? std::to_string(opt.modbusPort).c_str() : "");
    platform.log(msg);
    if (opt.password.empty()) platform.log("Warning: no password set (use --password-file on untrusted networks)");

    cpu.begin(!opt.stopped);

    std::vector<Client> clients;
    while (!stopRequested) {
        uint32_t wait = cpu.loop();

        std::vector<pollfd> fds;
        fds.push_back({server, POLLIN, 0});
        if (modbusServer >= 0) fds.push_back({modbusServer, POLLIN, 0});
        for (const Client& c : clients) fds.push_back({c.fd, POLLIN, 0});
        int ready = poll(fds.data(), fds.size(), int(wait > 50 ? 50 : wait));
        if (ready <= 0) continue;

        size_t base = modbusServer >= 0 ? 2 : 1;
        for (size_t k = 0; k < base; k++) {
            if (!(fds[k].revents & POLLIN)) continue;
            int fd = accept(fds[k].fd, nullptr, nullptr);
            if (fd < 0) continue;
            if (clients.size() >= MAX_CLIENTS) { close(fd); continue; }
            int one = 1;
            setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
            fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
            Client c{fd, fds[k].fd == modbusServer, Session(), nullptr, {}};
            if (!c.modbus) c.parser = std::make_unique<FrameParser>();
            clients.push_back(std::move(c));
        }

        std::vector<int> closed;
        for (size_t k = base; k < fds.size(); k++) {
            if (!(fds[k].revents & (POLLIN | POLLHUP | POLLERR))) continue;
            Client& c = clients[k - base];
            uint8_t buf[4096];
            ssize_t n = recv(c.fd, buf, sizeof buf, 0);
            if (n <= 0) {
                if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) continue;
                closed.push_back(c.fd);
                continue;
            }
            if (c.modbus) {
                c.buffer.insert(c.buffer.end(), buf, buf + n);
                while (c.buffer.size() >= 7) {
                    uint16_t len = uint16_t(c.buffer[4] << 8 | c.buffer[5]);
                    if (c.buffer[2] || c.buffer[3] || len < 2 || len > 254) { closed.push_back(c.fd); break; }
                    if (c.buffer.size() < size_t(6 + len)) break;
                    ModbusAreas areas;
                    uint32_t isz = 0, msz = 0;
                    areas.i = cpu.vm().area(uint8_t(Area::I), isz);
                    areas.m = cpu.vm().area(uint8_t(Area::M), msz);
                    areas.iSize = isz;
                    areas.mSize = msz;
                    std::vector<uint8_t> pdu = areas.i || areas.m
                        ? modbusServe(c.buffer.data() + 7, len - 1, areas)
                        : std::vector<uint8_t>{uint8_t(c.buffer[7] | 0x80), 4};
                    std::vector<uint8_t> adu(c.buffer.begin(), c.buffer.begin() + 7);
                    adu[4] = uint8_t((pdu.size() + 1) >> 8);
                    adu[5] = uint8_t(pdu.size() + 1);
                    adu.insert(adu.end(), pdu.begin(), pdu.end());
                    c.buffer.erase(c.buffer.begin(), c.buffer.begin() + 6 + len);
                    if (!sendAll(c.fd, adu.data(), adu.size())) { closed.push_back(c.fd); break; }
                }
            } else {
                for (ssize_t b = 0; b < n; b++) {
                    FrameParser::Result r = c.parser->feed(buf[b]);
                    if (r == FrameParser::ERROR) {
                        // Framing lost: drop the connection, the client reconnects.
                        closed.push_back(c.fd);
                        break;
                    }
                    if (r == FrameParser::FRAME) {
                        size_t len = cpu.handle(c.session, c.parser->command(), c.parser->sequence(), c.parser->payload(),
                                                c.parser->length(), response);
                        if (!sendAll(c.fd, response, len)) { closed.push_back(c.fd); break; }
                    }
                }
            }
        }
        for (int fd : closed) {
            close(fd);
            for (size_t k = 0; k < clients.size(); k++) {
                if (clients[k].fd == fd) { clients.erase(clients.begin() + long(k)); break; }
            }
        }
    }

    platform.log("Shutting down: outputs off");
    cpu.stop();
    for (Client& c : clients) close(c.fd);
    close(server);
    if (modbusServer >= 0) close(modbusServer);
    return 0;
}
