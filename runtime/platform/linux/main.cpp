// VirtualPLC CPU for Linux / Raspberry Pi.
//
//   vplc-cpu [--data DIR] [--listen ADDR] [--port 20105] [--name PLC_1] [--password SECRET]
//            [--modbus-port 5020] [--gpio-chip /dev/gpiochip0] [--watchdog-ms 1000]
//            [--max-program BYTES] [--max-data BYTES] [--stopped]
//            [--s7-port N] [--opcua-port N] [--hmi-user NAME --hmi-password-file FILE]
//
// The S7 communication and OPC UA servers are enabled in the CPU properties of the
// project (downloaded with the program); --s7-port / --opcua-port override the port
// (0 disables the server).
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
#include <sys/stat.h>
#include <termios.h>
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
#include "s7.h"
#include "security/tls.h"
#ifdef VPLC_WITH_OPCUA
#include "opcua.h"
#endif

using namespace vplc;

namespace {

volatile sig_atomic_t stopRequested = 0;

void onSignal(int) { stopRequested = 1; }

// "address:port" of a client, for the audit trail
void peerName(const sockaddr_storage& a, char* out, size_t cap) {
    char ip[INET6_ADDRSTRLEN] = "?";
    int port = 0;
    if (a.ss_family == AF_INET) {
        auto* v4 = reinterpret_cast<const sockaddr_in*>(&a);
        inet_ntop(AF_INET, &v4->sin_addr, ip, sizeof ip);
        port = ntohs(v4->sin_port);
        snprintf(out, cap, "%s:%d", ip, port);
    } else if (a.ss_family == AF_INET6) {
        auto* v6 = reinterpret_cast<const sockaddr_in6*>(&a);
        inet_ntop(AF_INET6, &v6->sin6_addr, ip, sizeof ip);
        port = ntohs(v6->sin6_port);
        snprintf(out, cap, "[%s]:%d", ip, port);
    } else {
        snprintf(out, cap, "?");
    }
}

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
    int s7Port = -1;     // -1: from the project, 0: disabled
    int opcuaPort = -1;  // -1: from the project, 0: disabled
    std::string hmiUser, hmiPassword;
    std::string serial;  // serial device for the device protocol (e.g. /dev/ttyGS0), with speed
    int serialBaud = 115200;
    bool tlsRequired = false;  // refuse the plain device protocol on the network
    bool signedPrograms = false;  // accept only programs signed with a trusted engineering key
    std::string trustKey;         // --trust-key NAME:HEX, then exit
    std::string addUser;  // --add-user NAME: create or replace a user (password on stdin), then exit
    int addRole = 4;
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
        "  --stopped             do not start the stored program automatically\n"
        "  --s7-port N           S7 communication (HMI) port, 0 = disabled (default: project, 102)\n"
        "  --opcua-port N        OPC UA server port, 0 = disabled (default: project, 4840)\n"
        "  --hmi-user NAME       OPC UA user name (with --hmi-password-file)\n"
        "  --hmi-password-file F OPC UA password (first line of F)\n"
        "  --serial DEV[:BAUD]   also serve the Studio on a serial link (e.g. /dev/ttyGS0:115200)\n"
        "  --tls-required        refuse unencrypted Studio connections on the network\n"
        "  --signed-programs     accept only programs signed with a trusted engineering key\n"
        "  --trust-key NAME:KEY  trust an engineering public key (hex) and exit\n"
        "  --add-user NAME       create or replace a user (password read on stdin) and exit\n"
        "  --role ROLE           role of --add-user: viewer, operator, engineer, admin (default)\n",
        VPLC_FIRMWARE_VERSION, unsigned(PROTOCOL_PORT));
}

bool parse(int argc, char** argv, Options& o) {
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        auto next = [&]() -> const char* { return i + 1 < argc ? argv[++i] : nullptr; };
        const char* v = nullptr;
        if (a == "--stopped") { o.stopped = true; continue; }
        if (a == "--tls-required") { o.tlsRequired = true; continue; }
        if (a == "--signed-programs") { o.signedPrograms = true; continue; }
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
        else if (a == "--s7-port") o.s7Port = atoi(v);
        else if (a == "--opcua-port") o.opcuaPort = atoi(v);
        else if (a == "--hmi-user") o.hmiUser = v;
        else if (a == "--add-user") o.addUser = v;
        else if (a == "--trust-key") o.trustKey = v;
        else if (a == "--role") {
            std::string r = v;
            o.addRole = r == "viewer" ? 1 : r == "operator" ? 2 : r == "engineer" ? 3 : r == "admin" ? 4 : 0;
            if (!o.addRole) { fprintf(stderr, "Unknown role %s\n", v); return false; }
        }
        else if (a == "--serial") {
            std::string d = v;
            size_t colon = d.rfind(':');
            if (colon != std::string::npos && colon > 5) {
                o.serialBaud = atoi(d.c_str() + colon + 1);
                d.resize(colon);
            }
            o.serial = d;
        }
        else if (a == "--password-file" || a == "--hmi-password-file") {
            FILE* f = fopen(v, "r");
            char line[64] = {0};
            if (!f || !fgets(line, sizeof line, f)) { fprintf(stderr, "Cannot read %s\n", v); if (f) fclose(f); return false; }
            fclose(f);
            line[strcspn(line, "\r\n")] = 0;
            (a == "--password-file" ? o.password : o.hmiPassword) = line;
        } else {
            fprintf(stderr, "Unknown option %s\n", a.c_str());
            return false;
        }
    }
    return true;
}

speed_t baudConstant(int baud) {
    switch (baud) {
        case 9600: return B9600;
        case 19200: return B19200;
        case 38400: return B38400;
        case 57600: return B57600;
        case 230400: return B230400;
        case 460800: return B460800;
        case 921600: return B921600;
        default: return B115200;
    }
}

/** Opens a serial device in raw mode (non-blocking reads). */
int openSerial(const std::string& path, int baud) {
    int fd = open(path.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return -1;
    termios t{};
    if (tcgetattr(fd, &t) == 0) {
        cfmakeraw(&t);
        cfsetispeed(&t, baudConstant(baud));
        cfsetospeed(&t, baudConstant(baud));
        t.c_cflag |= CLOCAL | CREAD;
        t.c_cflag &= ~CRTSCTS;
        tcsetattr(fd, TCSANOW, &t);
    }
    return fd;
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

enum class Kind { DEVICE, MODBUS, S7 };

struct Client {
    int fd;
    Kind kind;
    Session session;
    std::unique_ptr<FrameParser> parser;  // device protocol
    std::vector<uint8_t> buffer;          // Modbus receive buffer
    std::unique_ptr<S7Session> s7;
    SSL* ssl = nullptr;         // device protocol over TLS
    bool detected = false;      // first byte seen (TLS ClientHello or plain frame)
    bool plainRefused = false;  // plain connection to a CPU with --tls-required
};

// Device protocol: send over TLS or plain TCP
bool sendDevice(Client& c, const uint8_t* data, size_t len) {
    if (!c.ssl) return sendAll(c.fd, data, len);
    while (len) {
        int n = SSL_write(c.ssl, data, int(len));
        if (n > 0) {
            data += n;
            len -= size_t(n);
            continue;
        }
        int e = SSL_get_error(c.ssl, n);
        if (e != SSL_ERROR_WANT_WRITE && e != SSL_ERROR_WANT_READ) return false;
        pollfd p{c.fd, short(e == SSL_ERROR_WANT_WRITE ? POLLOUT : POLLIN), 0};
        if (poll(&p, 1, 1000) <= 0) return false;
    }
    return true;
}

struct Listener {
    int fd = -1;
    Kind kind;
    int port = 0;
};

constexpr size_t MAX_CLIENTS = 32;

bool sendToFd(void* ctx, const uint8_t* data, size_t length) { return sendAll(*static_cast<int*>(ctx), data, length); }

void serveModbus(Client& c, Cpu& cpu, std::vector<int>& closed) {
    while (c.buffer.size() >= 7) {
        uint16_t len = uint16_t(c.buffer[4] << 8 | c.buffer[5]);
        if (c.buffer[2] || c.buffer[3] || len < 2 || len > 254) { closed.push_back(c.fd); return; }
        if (c.buffer.size() < size_t(6 + len)) return;
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
        if (!sendAll(c.fd, adu.data(), adu.size())) { closed.push_back(c.fd); return; }
    }
}

}  // namespace

int main(int argc, char** argv) {
    Options opt;
    if (!parse(argc, argv, opt)) return 2;

    if (!opt.trustKey.empty()) {
        size_t colon = opt.trustKey.find(':');
        mkdir(opt.dataDir.c_str(), 0755);
        sec::Security security(opt.dataDir);
        security.setPlcName(opt.name);
        const char* err = colon == std::string::npos ? "expected NAME:KEY" : security.trustKey(opt.trustKey.substr(0, colon), opt.trustKey.substr(colon + 1));
        if (err) { fprintf(stderr, "%s\n", err); return 1; }
        security.audit("root", "console", "key trusted", opt.trustKey.substr(0, colon));
        fprintf(stderr, "Key %s trusted\n", opt.trustKey.substr(0, colon).c_str());
        return 0;
    }

    if (!opt.addUser.empty()) {
        // Password from stdin (no echo on a terminal): never on the command line
        bool tty = isatty(0);
        termios saved{};
        if (tty) {
            fprintf(stderr, "Password of %s: ", opt.addUser.c_str());
            tcgetattr(0, &saved);
            termios quiet = saved;
            quiet.c_lflag &= ~tcflag_t(ECHO);
            tcsetattr(0, TCSANOW, &quiet);
        }
        char line[160] = {0};
        bool got = fgets(line, sizeof line, stdin) != nullptr;
        if (tty) {
            tcsetattr(0, TCSANOW, &saved);
            fprintf(stderr, "\n");
        }
        line[strcspn(line, "\r\n")] = 0;
        if (!got || !line[0]) { fprintf(stderr, "No password given\n"); return 2; }
        mkdir(opt.dataDir.c_str(), 0755);
        sec::Security security(opt.dataDir);
        security.setPlcName(opt.name);
        const char* err = security.setUser(opt.addUser, line, uint8_t(opt.addRole));
        memset(line, 0, sizeof line);
        if (err) { fprintf(stderr, "%s\n", err); return 1; }
        security.audit("root", "console", "user set", opt.addUser);
        fprintf(stderr, "User %s saved in %s/users\n", opt.addUser.c_str(), opt.dataDir.c_str());
        return 0;
    }

    signal(SIGTERM, onSignal);
    signal(SIGINT, onSignal);
    signal(SIGPIPE, SIG_IGN);

    std::vector<uint8_t> programBuffer(opt.maxProgram), arena(opt.maxData);
    static uint8_t response[VPLC_MAX_PAYLOAD + 16];

    LinuxPlatform platform(opt.dataDir, opt.gpioChip);
    Cpu cpu(platform, programBuffer.data(), programBuffer.size(), arena.data(), arena.size());
    cpu.setName(opt.name.c_str());
    platform.setPlcName(opt.name);
    platform.security().setSignedRequired(opt.signedPrograms);
    cpu.setPassword(opt.password.c_str());
    cpu.setWatchdog(opt.watchdogMs);

    // TLS with the identity key of the CPU (pinned by the Studio)
    sec::TlsServer tls;
    {
        std::string err;
        char msg[200];
        if (tls.init(opt.dataDir, opt.name, err)) snprintf(msg, sizeof msg, "TLS enabled, CPU key fingerprint %s%s", tls.fingerprint().c_str(), opt.tlsRequired ? " (TLS required)" : "");
        else snprintf(msg, sizeof msg, "TLS unavailable: %s", err.c_str());
        platform.log(msg);
    }

    std::vector<Listener> listeners;
    listeners.push_back({listenOn(opt.listen, opt.port), Kind::DEVICE, opt.port});
    if (listeners[0].fd < 0) {
        fprintf(stderr, "Cannot listen on %s:%d: %s\n", opt.listen.c_str(), opt.port, strerror(errno));
        return 1;
    }
    if (opt.modbusPort > 0) {
        listeners.push_back({listenOn(opt.listen, opt.modbusPort), Kind::MODBUS, opt.modbusPort});
        if (listeners.back().fd < 0) {
            fprintf(stderr, "Cannot listen on Modbus port %d: %s\n", opt.modbusPort, strerror(errno));
            return 1;
        }
    }
    char msg[200];
    snprintf(msg, sizeof msg, "VirtualPLC CPU %s '%s' listening on %s:%d%s%s", VPLC_FIRMWARE_VERSION, opt.name.c_str(),
             opt.listen.c_str(), opt.port, opt.modbusPort > 0 ? ", Modbus HMI server on port " : "",
             opt.modbusPort > 0 ? std::to_string(opt.modbusPort).c_str() : "");
    platform.log(msg);
    if (platform.hasUsers()) platform.log("User accounts enabled (role-based access control, audit trail)");
    else if (opt.password.empty()) platform.log("Warning: no user and no password: anyone on the network can program this CPU (use --add-user)");

    cpu.begin(!opt.stopped);

    std::vector<Client> clients;
    auto closeClient = [&](int fd) {
        for (size_t k = 0; k < clients.size(); k++) {
            if (clients[k].fd == fd) {
                if (clients[k].ssl) SSL_free(clients[k].ssl);
                clients.erase(clients.begin() + long(k));
                break;
            }
        }
        close(fd);
    };

    // S7 communication server: follows the CPU properties of the loaded program
    Listener s7{-1, Kind::S7, 0};
    int s7Failed = 0;
    auto reconcileS7 = [&]() {
        const Program::Services& sv = cpu.program().services;
        bool loaded = cpu.state() != 0 && cpu.program().id != 0;
        int want = opt.s7Port >= 0 ? (loaded ? opt.s7Port : 0) : (loaded && sv.s7 ? sv.s7Port : 0);
        if (want == s7.port) return;
        if (s7.fd >= 0) {
            close(s7.fd);
            std::vector<int> drop;
            for (Client& c : clients) if (c.kind == Kind::S7) drop.push_back(c.fd);
            for (int fd : drop) closeClient(fd);
            platform.log("S7 communication server stopped");
        }
        s7 = {-1, Kind::S7, want};
        if (!want) return;
        s7.fd = listenOn(opt.listen, want);
        if (s7.fd < 0) {
            if (s7Failed != want) {
                snprintf(msg, sizeof msg, "Cannot open S7 communication port %d: %s%s", want, strerror(errno),
                         want < 1024 ? " (the service needs CAP_NET_BIND_SERVICE for ports below 1024)" : "");
                platform.log(msg);
            }
            s7Failed = want;
            return;
        }
        s7Failed = 0;
        snprintf(msg, sizeof msg, "S7 communication server on port %d (%s)", want, sv.s7Write ? "read/write" : "read only");
        platform.log(msg);
    };

#ifdef VPLC_WITH_OPCUA
    OpcUaServer opcua(cpu, platform);
    opcua.setUser(opt.hmiUser, opt.hmiPassword);
    auto reconcileOpcUa = [&]() {
        const Program::Services& sv = cpu.program().services;
        bool loaded = cpu.state() != 0 && cpu.program().id != 0;
        int want = opt.opcuaPort >= 0 ? (loaded ? opt.opcuaPort : 0) : (loaded && sv.opcua ? sv.opcuaPort : 0);
        opcua.configure(uint16_t(want), sv.opcuaWrite, sv.opcuaAnonymous, opt.name);
    };
#endif

    // serial link (optional): one session, framing errors resynchronise instead of closing
    int serialFd = -1;
    FrameParser serialParser;
    Session serialSession;
    snprintf(serialSession.peer, sizeof serialSession.peer, "serial");
    if (!opt.serial.empty()) {
        serialFd = openSerial(opt.serial, opt.serialBaud);
        char msg[160];
        snprintf(msg, sizeof msg, serialFd >= 0 ? "Serial link %s at %d bauds" : "Cannot open the serial link %s", opt.serial.c_str(), opt.serialBaud);
        platform.log(msg);
    }

    while (!stopRequested) {
        uint32_t wait = cpu.loop();
        reconcileS7();
#ifdef VPLC_WITH_OPCUA
        reconcileOpcUa();
        opcua.iterate();
        if (opcua.running() && wait > 10) wait = 10;
#endif

        std::vector<pollfd> fds;
        std::vector<Listener> active = listeners;
        if (s7.fd >= 0) active.push_back(s7);
        for (const Listener& l : active) fds.push_back({l.fd, POLLIN, 0});
        for (const Client& c : clients) fds.push_back({c.fd, POLLIN, 0});
        if (serialFd >= 0) fds.push_back({serialFd, POLLIN, 0});
        int ready = poll(fds.data(), fds.size(), int(wait > 50 ? 50 : wait));
        if (ready <= 0) continue;
        if (serialFd >= 0 && (fds.back().revents & POLLIN)) {
            uint8_t sbuf[512];
            ssize_t n;
            while ((n = read(serialFd, sbuf, sizeof sbuf)) > 0) {
                for (ssize_t b = 0; b < n; b++) {
                    FrameParser::Result r = serialParser.feed(sbuf[b]);
                    if (r == FrameParser::ERROR) {
                        serialParser.reset();
                    } else if (r == FrameParser::FRAME) {
                        size_t len = cpu.handle(serialSession, serialParser.command(), serialParser.sequence(), serialParser.payload(),
                                                serialParser.length(), response);
                        for (size_t off = 0; off < len;) {
                            ssize_t w = write(serialFd, response + off, len - off);
                            if (w > 0) off += size_t(w);
                            else if (errno == EAGAIN) poll(&fds.back(), 0, 5);
                            else break;
                        }
                    }
                }
            }
        }

        size_t base = active.size();
        std::vector<Client> accepted;
        for (size_t k = 0; k < base; k++) {
            if (!(fds[k].revents & POLLIN)) continue;
            sockaddr_storage addr{};
            socklen_t alen = sizeof addr;
            int fd = accept(fds[k].fd, reinterpret_cast<sockaddr*>(&addr), &alen);
            if (fd < 0) continue;
            if (clients.size() + accepted.size() >= MAX_CLIENTS) { close(fd); continue; }
            int one = 1;
            setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
            fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
            Client c{fd, active[k].kind, Session(), nullptr, {}, nullptr};
            peerName(addr, c.session.peer, sizeof c.session.peer);
            if (c.kind == Kind::DEVICE) c.parser = std::make_unique<FrameParser>();
            if (c.kind == Kind::S7) c.s7 = std::make_unique<S7Session>();
            accepted.push_back(std::move(c));
        }

        std::vector<int> closed;
        for (size_t k = base; k < base + clients.size(); k++) {
            if (!(fds[k].revents & (POLLIN | POLLHUP | POLLERR))) continue;
            Client& c = clients[k - base];
            uint8_t buf[4096];
            if (c.kind == Kind::DEVICE && !c.detected) {
                uint8_t first = 0;
                ssize_t pk = recv(c.fd, &first, 1, MSG_PEEK);
                if (pk <= 0) {
                    if (pk < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) continue;
                    closed.push_back(c.fd);
                    continue;
                }
                c.detected = true;
                if (first == 0x16 && tls.ready()) c.ssl = tls.wrap(c.fd);  // TLS handshake record
                else if (opt.tlsRequired) c.plainRefused = true;
            }
            if (c.ssl) {
                if (!SSL_is_init_finished(c.ssl)) {
                    int r = SSL_accept(c.ssl);
                    if (r <= 0) {
                        int e = SSL_get_error(c.ssl, r);
                        if (e != SSL_ERROR_WANT_READ && e != SSL_ERROR_WANT_WRITE) closed.push_back(c.fd);
                        continue;
                    }
                }
                bool drop = false;
                for (;;) {
                    int n = SSL_read(c.ssl, buf, sizeof buf);
                    if (n <= 0) {
                        int e = SSL_get_error(c.ssl, n);
                        if (e != SSL_ERROR_WANT_READ && e != SSL_ERROR_WANT_WRITE) drop = true;
                        break;
                    }
                    for (int b = 0; b < n && !drop; b++) {
                        FrameParser::Result r = c.parser->feed(buf[b]);
                        if (r == FrameParser::ERROR) drop = true;
                        else if (r == FrameParser::FRAME) {
                            size_t len = cpu.handle(c.session, c.parser->command(), c.parser->sequence(), c.parser->payload(),
                                                    c.parser->length(), response);
                            if (!sendDevice(c, response, len)) drop = true;
                        }
                    }
                    if (drop || SSL_pending(c.ssl) == 0) break;
                }
                if (drop) closed.push_back(c.fd);
                continue;
            }
            ssize_t n = recv(c.fd, buf, sizeof buf, 0);
            if (n <= 0) {
                if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) continue;
                closed.push_back(c.fd);
                continue;
            }
            if (c.kind == Kind::MODBUS) {
                c.buffer.insert(c.buffer.end(), buf, buf + n);
                serveModbus(c, cpu, closed);
            } else if (c.kind == Kind::S7) {
                S7Session::Options o;
                o.allowWrite = cpu.program().services.s7Write;
                o.name = opt.name.c_str();
                int fd = c.fd;
                if (!c.s7->receive(buf, size_t(n), cpu.vm(), cpu.program(), o, sendToFd, &fd)) closed.push_back(c.fd);
            } else {
                for (ssize_t b = 0; b < n; b++) {
                    FrameParser::Result r = c.parser->feed(buf[b]);
                    if (r == FrameParser::ERROR) {
                        // Framing lost: drop the connection, the client reconnects.
                        closed.push_back(c.fd);
                        break;
                    }
                    if (r == FrameParser::FRAME) {
                        size_t len;
                        if (c.plainRefused) {
                            static const char refused[] = "this CPU requires an encrypted connection (TLS): update the Studio";
                            len = encodeResponse(response, c.parser->command(), c.parser->sequence(), uint8_t(Status::ST_UNAUTHORIZED),
                                                 reinterpret_cast<const uint8_t*>(refused), sizeof refused - 1);
                        } else {
                            len = cpu.handle(c.session, c.parser->command(), c.parser->sequence(), c.parser->payload(),
                                             c.parser->length(), response);
                        }
                        if (!sendAll(c.fd, response, len)) { closed.push_back(c.fd); break; }
                    }
                }
            }
        }
        for (int fd : closed) closeClient(fd);
        for (Client& c : accepted) clients.push_back(std::move(c));
    }

    platform.log("Shutting down: outputs off");
    cpu.stop();
    for (Client& c : clients) {
        if (c.ssl) SSL_free(c.ssl);
        close(c.fd);
    }
    for (const Listener& l : listeners) close(l.fd);
    if (s7.fd >= 0) close(s7.fd);
    return 0;
}
