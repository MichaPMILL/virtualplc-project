#include "enip.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include <random>

namespace vplc::enip {

namespace {

constexpr uint16_t ENCAP_LIST_IDENTITY = 0x63;
constexpr uint16_t ENCAP_REGISTER_SESSION = 0x65;
constexpr uint16_t ENCAP_UNREGISTER_SESSION = 0x66;
constexpr uint16_t ENCAP_SEND_RR_DATA = 0x6F;
constexpr uint16_t ITEM_NULL = 0x0000;
constexpr uint16_t ITEM_IDENTITY = 0x000C;
constexpr uint16_t ITEM_CONNECTED_DATA = 0x00B1;
constexpr uint16_t ITEM_UNCONNECTED_DATA = 0x00B2;
constexpr uint16_t ITEM_SOCKADDR_TO = 0x8001;
constexpr uint16_t ITEM_SEQUENCED_ADDRESS = 0x8002;
constexpr uint8_t SERVICE_FORWARD_OPEN = 0x54;
constexpr uint8_t SERVICE_FORWARD_CLOSE = 0x4E;
// Originator vendor id sent in the Forward_Open (0xFFFE: not assigned to a vendor)
constexpr uint16_t ORIGINATOR_VENDOR = 0xFFFE;

uint64_t nowUs() {
    timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return uint64_t(ts.tv_sec) * 1000000u + uint64_t(ts.tv_nsec) / 1000u;
}

void put16(std::vector<uint8_t>& v, uint16_t x) {
    v.push_back(uint8_t(x));
    v.push_back(uint8_t(x >> 8));
}
void put32(std::vector<uint8_t>& v, uint32_t x) {
    put16(v, uint16_t(x));
    put16(v, uint16_t(x >> 16));
}
uint16_t get16(const uint8_t* p) { return uint16_t(p[0] | (p[1] << 8)); }
uint32_t get32(const uint8_t* p) { return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24); }

std::vector<uint8_t> encap(uint16_t command, uint32_t session, const std::vector<uint8_t>& data) {
    std::vector<uint8_t> v;
    put16(v, command);
    put16(v, uint16_t(data.size()));
    put32(v, session);
    put32(v, 0);                        // status
    for (int k = 0; k < 8; k++) v.push_back(0);  // sender context
    put32(v, 0);                        // options
    v.insert(v.end(), data.begin(), data.end());
    return v;
}

// Logical segments: class / instance / connection point (8 or 16 bit)
void segment(std::vector<uint8_t>& p, uint8_t type8, uint16_t value) {
    if (value <= 0xFF) {
        p.push_back(type8);
        p.push_back(uint8_t(value));
    } else {
        p.push_back(uint8_t(type8 | 1));
        p.push_back(0);
        put16(p, value);
    }
}

std::vector<uint8_t> connectionPath(const AdapterConfig& c, bool withData) {
    std::vector<uint8_t> p;
    if (c.electronicKey) {
        p.push_back(0x34);
        p.push_back(0x04);
        put16(p, c.vendorId);
        put16(p, c.deviceType);
        put16(p, c.productCode);
        p.push_back(uint8_t(0x80 | (c.revMajor & 0x7F)));  // compatibility: newer revisions accepted
        p.push_back(c.revMinor);
    }
    segment(p, 0x20, 0x04);              // Assembly class
    segment(p, 0x24, c.configInstance);  // configuration instance
    segment(p, 0x2C, c.outInstance);     // O->T connection point
    segment(p, 0x2C, c.inInstance);      // T->O connection point
    if (withData && !c.configData.empty()) {
        std::vector<uint8_t> d = c.configData;
        if (d.size() % 2) d.push_back(0);
        p.push_back(0x80);
        p.push_back(uint8_t(d.size() / 2));
        p.insert(p.end(), d.begin(), d.end());
    }
    return p;
}

uint32_t multiplier(uint8_t code) { return 4u << (code > 7 ? 7 : code); }

bool waitFd(int fd, short events, int timeoutMs) {
    pollfd p{fd, events, 0};
    return poll(&p, 1, timeoutMs) > 0 && (p.revents & events);
}

bool sendAllFd(int fd, const uint8_t* d, size_t n) {
    while (n) {
        ssize_t w = send(fd, d, n, MSG_NOSIGNAL);
        if (w < 0 && (errno == EAGAIN || errno == EINTR)) {
            if (!waitFd(fd, POLLOUT, 2000)) return false;
            continue;
        }
        if (w <= 0) return false;
        d += w;
        n -= size_t(w);
    }
    return true;
}

bool recvAll(int fd, uint8_t* d, size_t n, int timeoutMs) {
    while (n) {
        if (!waitFd(fd, POLLIN, timeoutMs)) return false;
        ssize_t r = recv(fd, d, n, 0);
        if (r <= 0) return false;
        d += r;
        n -= size_t(r);
    }
    return true;
}

bool resolve(const std::string& host, uint32_t& ip) {
    in_addr a{};
    if (inet_pton(AF_INET, host.c_str(), &a) == 1) {
        ip = a.s_addr;
        return true;
    }
    addrinfo hints{}, *res = nullptr;
    hints.ai_family = AF_INET;
    if (getaddrinfo(host.c_str(), nullptr, &hints, &res) != 0 || !res) return false;
    ip = reinterpret_cast<sockaddr_in*>(res->ai_addr)->sin_addr.s_addr;
    freeaddrinfo(res);
    return true;
}

}  // namespace

std::string cipStatusText(uint8_t general, uint16_t extended) {
    const char* text = nullptr;
    if (general == 0x01) {
        switch (extended) {
            case 0x0100: text = "connection in use or duplicate Forward_Open"; break;
            case 0x0103: text = "transport class and trigger not supported"; break;
            case 0x0106: text = "ownership conflict (another scanner owns the outputs)"; break;
            case 0x0107: text = "connection not found"; break;
            case 0x0108: text = "invalid network connection parameter"; break;
            case 0x0109: text = "invalid connection size"; break;
            case 0x0110: text = "target not configured"; break;
            case 0x0111: text = "RPI not supported"; break;
            case 0x0113: text = "out of connections"; break;
            case 0x0114: text = "vendor id or product code mismatch (electronic key)"; break;
            case 0x0115: text = "device type mismatch (electronic key)"; break;
            case 0x0116: text = "revision mismatch (electronic key)"; break;
            case 0x0117: text = "invalid produced or consumed application path (assembly instance)"; break;
            case 0x0118: text = "invalid or inconsistent configuration (configuration instance or data)"; break;
            case 0x0119: text = "non-listen only connection not opened"; break;
            case 0x011A: text = "target object out of connections"; break;
            case 0x011B: text = "RPI smaller than the production inhibit time"; break;
            case 0x0127: text = "invalid O->T size (output length)"; break;
            case 0x0128: text = "invalid T->O size (input length)"; break;
            case 0x0203: text = "connection timed out"; break;
            case 0x0204: text = "unconnected request timed out"; break;
            case 0x0311: text = "invalid port in the path"; break;
            case 0x0315: text = "invalid segment in the connection path"; break;
            default: break;
        }
    } else {
        switch (general) {
            case 0x02: text = "resource unavailable"; break;
            case 0x04: text = "path segment error"; break;
            case 0x05: text = "path destination unknown (object or instance)"; break;
            case 0x08: text = "service not supported"; break;
            case 0x09: text = "invalid attribute value"; break;
            case 0x0C: text = "object state conflict"; break;
            case 0x13: text = "not enough data"; break;
            case 0x14: text = "attribute not supported"; break;
            case 0x15: text = "too much data"; break;
            case 0x1E: text = "embedded service error"; break;
            case 0x20: text = "invalid parameter"; break;
            default: break;
        }
    }
    char head[32];
    snprintf(head, sizeof head, "CIP 0x%02X/0x%04X", general, extended);
    return std::string(head) + (text ? std::string(": ") + text : std::string());
}

std::vector<uint8_t> forwardOpenData(const AdapterConfig& c, uint32_t toId, uint16_t serial, uint32_t originatorSerial) {
    std::vector<uint8_t> d;
    d.push_back(0x0A);  // priority / time tick
    d.push_back(0x0E);  // timeout ticks
    put32(d, 0);        // O->T connection id: chosen by the target
    put32(d, toId);     // T->O connection id: chosen by the originator (point to point)
    put16(d, serial);
    put16(d, ORIGINATOR_VENDOR);
    put32(d, originatorSerial);
    d.push_back(c.timeoutMultiplier > 7 ? 7 : c.timeoutMultiplier);
    d.push_back(0);
    d.push_back(0);
    d.push_back(0);
    const uint16_t otSize = uint16_t(c.outLength + 2 + (c.outHeader ? 4 : 0));
    const uint16_t toSize = uint16_t(c.inLength + 2 + (c.inHeader ? 4 : 0));
    put32(d, c.rpiUs);
    put16(d, uint16_t(0x4000 | 0x0800 | (otSize & 0x1FF)));  // point to point, scheduled, fixed
    put32(d, c.rpiUs);
    put16(d, uint16_t((c.multicast ? 0x2000 : 0x4000) | 0x0800 | (toSize & 0x1FF)));
    d.push_back(0x01);  // class 1, cyclic
    std::vector<uint8_t> path = connectionPath(c, true);
    d.push_back(uint8_t(path.size() / 2));
    d.insert(d.end(), path.begin(), path.end());
    return d;
}

Scanner::Scanner(std::vector<AdapterConfig> adapters, Logger log, uint16_t udpPort) : log_(std::move(log)), udpPort_(udpPort) {
    std::random_device rd;
    originatorSerial_ = rd();
    for (AdapterConfig& c : adapters) {
        Adapter a;
        a.cfg = std::move(c);
        a.in.assign(a.cfg.inLength, 0);
        a.out.assign(a.cfg.outLength, 0);
        a.status = "not connected";
        adapters_.push_back(std::move(a));
    }
}

Scanner::~Scanner() {
    stop_ = true;
    if (manager_.joinable()) manager_.join();
    if (io_.joinable()) io_.join();
    for (Adapter& a : adapters_) disconnect(a, true);
    if (udp_ >= 0) close(udp_);
}

bool Scanner::start(std::string& err) {
    for (Adapter& a : adapters_) {
        const AdapterConfig& c = a.cfg;
        if (c.outLength + 6 > 511 || c.inLength + 6 > 511) {
            err = "EtherNet/IP adapter " + c.name + ": assemblies larger than 505 bytes are not supported (Large_Forward_Open)";
            return false;
        }
    }
    udp_ = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    int one = 1;
    setsockopt(udp_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    sockaddr_in sa{};
    sa.sin_family = AF_INET;
    sa.sin_port = htons(udpPort_);
    if (udp_ < 0 || bind(udp_, reinterpret_cast<sockaddr*>(&sa), sizeof sa) < 0) {
        err = std::string("EtherNet/IP: cannot use UDP port ") + std::to_string(udpPort_) + " for the I/O: " + strerror(errno);
        return false;
    }
    int prio = 6;  // high priority on the interface queue
    setsockopt(udp_, SOL_SOCKET, SO_PRIORITY, &prio, sizeof prio);
    int tos = 0xB8;  // DSCP 46 (EF): class 1 I/O as recommended by ODVA
    setsockopt(udp_, IPPROTO_IP, IP_TOS, &tos, sizeof tos);
    manager_ = std::thread([this] { manage(); });
    io_ = std::thread([this] { exchange(); });
    return true;
}

void Scanner::fail(Adapter& a, const std::string& why) {
    // called with mutex_ held
    const bool wasRunning = a.state == State::RUNNING;
    a.state = State::FAILED;
    a.status = why;
    a.rxSeen = false;
    std::fill(a.in.begin(), a.in.end(), 0);  // substitute values
    a.retryAtUs = nowUs() + uint64_t(a.backoffMs) * 1000u;
    a.backoffMs = a.backoffMs < 16000 ? a.backoffMs * 2 : 30000;
    if (wasRunning || a.timeouts == 0) log_("EtherNet/IP " + a.cfg.name + " (" + a.cfg.host + "): " + why);
    if (wasRunning) a.timeouts++;
}

bool Scanner::request(Adapter& a, uint16_t command, const std::vector<uint8_t>& body, std::vector<uint8_t>& reply, std::string& err) {
    std::vector<uint8_t> msg = encap(command, a.session, body);
    if (!sendAllFd(a.tcp, msg.data(), msg.size())) {
        err = "connection to the adapter lost";
        return false;
    }
    uint8_t head[24];
    if (!recvAll(a.tcp, head, sizeof head, 3000)) {
        err = "no answer from the adapter";
        return false;
    }
    uint16_t len = get16(head + 2);
    uint32_t status = get32(head + 8);
    reply.assign(len, 0);
    if (len && !recvAll(a.tcp, reply.data(), len, 3000)) {
        err = "truncated answer from the adapter";
        return false;
    }
    if (get16(head) != command) {
        err = "unexpected encapsulation answer";
        return false;
    }
    if (status) {
        err = "encapsulation error " + std::to_string(status);
        return false;
    }
    if (command == ENCAP_REGISTER_SESSION) a.session = get32(head + 4);
    return true;
}

bool Scanner::cip(Adapter& a, const std::vector<uint8_t>& message, std::vector<uint8_t>& reply, std::vector<uint8_t>* items, std::string& err) {
    std::vector<uint8_t> body;
    put32(body, 0);   // interface handle
    put16(body, 10);  // timeout (s)
    put16(body, 2);   // item count
    put16(body, ITEM_NULL);
    put16(body, 0);
    put16(body, ITEM_UNCONNECTED_DATA);
    put16(body, uint16_t(message.size()));
    body.insert(body.end(), message.begin(), message.end());
    std::vector<uint8_t> r;
    if (!request(a, ENCAP_SEND_RR_DATA, body, r, err)) return false;
    if (r.size() < 8) {
        err = "short SendRRData answer";
        return false;
    }
    uint16_t count = get16(r.data() + 6);
    size_t p = 8;
    const uint8_t* data = nullptr;
    size_t dataLen = 0;
    for (uint16_t k = 0; k < count && p + 4 <= r.size(); k++) {
        uint16_t type = get16(r.data() + p), len = get16(r.data() + p + 2);
        if (p + 4 + len > r.size()) break;
        if (type == ITEM_UNCONNECTED_DATA) {
            data = r.data() + p + 4;
            dataLen = len;
        } else if (type == ITEM_SOCKADDR_TO && items) {
            items->assign(r.begin() + long(p + 4), r.begin() + long(p + 4 + len));
        }
        p += 4 + len;
    }
    if (!data || dataLen < 4) {
        err = "no CIP answer";
        return false;
    }
    uint8_t general = data[2];
    uint8_t extWords = data[3];
    uint16_t extended = extWords && dataLen >= 6 ? get16(data + 4) : 0;
    size_t start = 4 + size_t(extWords) * 2;
    if (general != 0) {
        err = cipStatusText(general, extended);
        return false;
    }
    reply.assign(data + (start < dataLen ? start : dataLen), data + dataLen);
    return true;
}

bool Scanner::connect(Adapter& a, std::string& err) {
    const AdapterConfig& c = a.cfg;
    if (!resolve(c.host, a.ip)) {
        err = "unknown host " + c.host;
        return false;
    }
    a.tcp = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    sockaddr_in sa{};
    sa.sin_family = AF_INET;
    sa.sin_port = htons(c.port);
    sa.sin_addr.s_addr = a.ip;
    int rc = ::connect(a.tcp, reinterpret_cast<sockaddr*>(&sa), sizeof sa);
    if (rc < 0 && errno != EINPROGRESS) {
        err = std::string("cannot connect: ") + strerror(errno);
        return false;
    }
    int soerr = 0;
    socklen_t sl = sizeof soerr;
    if (rc < 0 && (!waitFd(a.tcp, POLLOUT, 3000) || getsockopt(a.tcp, SOL_SOCKET, SO_ERROR, &soerr, &sl) < 0 || soerr)) {
        err = soerr ? std::string("cannot connect: ") + strerror(soerr) : "no answer (timeout)";
        return false;
    }
    int one = 1;
    setsockopt(a.tcp, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    std::vector<uint8_t> reply;
    a.session = 0;
    if (!request(a, ENCAP_REGISTER_SESSION, {1, 0, 0, 0}, reply, err)) return false;

    std::random_device rd;
    a.serial = uint16_t(rd());
    a.toId = rd() | 1u;
    std::vector<uint8_t> msg{SERVICE_FORWARD_OPEN, 0x02, 0x20, 0x06, 0x24, 0x01};  // Connection Manager, instance 1
    std::vector<uint8_t> data = forwardOpenData(c, a.toId, a.serial, originatorSerial_);
    msg.insert(msg.end(), data.begin(), data.end());
    std::vector<uint8_t> sockaddr;
    if (!cip(a, msg, reply, &sockaddr, err)) {
        err = "Forward_Open refused: " + err;
        return false;
    }
    if (reply.size() < 26) {
        err = "short Forward_Open answer";
        return false;
    }
    a.otId = get32(reply.data());
    a.toId = get32(reply.data() + 4);
    a.otApiUs = get32(reply.data() + 16);
    a.toApiUs = get32(reply.data() + 20);
    if (!a.otApiUs) a.otApiUs = c.rpiUs;
    if (!a.toApiUs) a.toApiUs = c.rpiUs;
    a.multicastGroup = 0;
    if (c.multicast && sockaddr.size() >= 8) {
        uint32_t group;
        memcpy(&group, sockaddr.data() + 4, 4);  // network order
        if ((ntohl(group) >> 28) == 0xE) {
            ip_mreq mreq{};
            mreq.imr_multiaddr.s_addr = group;
            mreq.imr_interface.s_addr = INADDR_ANY;
            if (setsockopt(udp_, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mreq, sizeof mreq) == 0) a.multicastGroup = group;
        }
    }
    return true;
}

void Scanner::disconnect(Adapter& a, bool sendClose) {
    if (a.tcp >= 0 && sendClose && a.otId) {
        std::vector<uint8_t> msg{SERVICE_FORWARD_CLOSE, 0x02, 0x20, 0x06, 0x24, 0x01, 0x0A, 0x0E};
        put16(msg, a.serial);
        put16(msg, ORIGINATOR_VENDOR);
        put32(msg, originatorSerial_);
        std::vector<uint8_t> path = connectionPath(a.cfg, false);
        msg.push_back(uint8_t(path.size() / 2));
        msg.push_back(0);
        msg.insert(msg.end(), path.begin(), path.end());
        std::vector<uint8_t> reply;
        std::string err;
        cip(a, msg, reply, nullptr, err);
    }
    if (a.tcp >= 0) {
        std::vector<uint8_t> msg = encap(ENCAP_UNREGISTER_SESSION, a.session, {});
        sendAllFd(a.tcp, msg.data(), msg.size());
        close(a.tcp);
        a.tcp = -1;
    }
    if (a.multicastGroup && udp_ >= 0) {
        ip_mreq mreq{};
        mreq.imr_multiaddr.s_addr = a.multicastGroup;
        mreq.imr_interface.s_addr = INADDR_ANY;
        setsockopt(udp_, IPPROTO_IP, IP_DROP_MEMBERSHIP, &mreq, sizeof mreq);
        a.multicastGroup = 0;
    }
    a.otId = 0;
}

void Scanner::manage() {
    while (!stop_) {
        for (size_t k = 0; k < adapters_.size() && !stop_; k++) {
            Adapter& a = adapters_[k];
            {
                std::lock_guard<std::mutex> lock(mutex_);
                if (a.state == State::RUNNING || a.state == State::CONNECTING) continue;
                if (a.state == State::FAILED && int64_t(nowUs() - a.retryAtUs) < 0) continue;
                a.state = State::CONNECTING;
            }
            disconnect(a, true);  // previous connection, if any
            std::string err;
            bool ok = connect(a, err);
            std::lock_guard<std::mutex> lock(mutex_);
            if (!ok) {
                if (a.tcp >= 0) {
                    close(a.tcp);
                    a.tcp = -1;
                }
                fail(a, err);
                continue;
            }
            const uint64_t now = nowUs();
            a.state = State::RUNNING;
            a.backoffMs = 1000;
            a.rxSeen = false;
            a.lastRxUs = now;
            a.nextSendUs = now;
            a.encapSeq = 0;
            char msg[200];
            snprintf(msg, sizeof msg, "connected (RPI %.1f ms, O->T id 0x%08X, T->O id 0x%08X%s)", a.otApiUs / 1000.0, a.otId, a.toId,
                     a.multicastGroup ? ", multicast" : "");
            a.status = msg;
            log_("EtherNet/IP " + a.cfg.name + " (" + a.cfg.host + "): " + msg);
        }
        for (int i = 0; i < 10 && !stop_; i++) usleep(20000);
    }
}

void Scanner::exchange() {
    uint8_t buf[1500];
    while (!stop_) {
        uint64_t now = nowUs();
        uint64_t wait = 5000;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            for (Adapter& a : adapters_) {
                if (a.state != State::RUNNING) continue;
                // connection timeout: no T->O data for RPI x multiplier
                const uint64_t timeout = uint64_t(a.toApiUs) * multiplier(a.cfg.timeoutMultiplier);
                if (now - a.lastRxUs > timeout + (a.rxSeen ? 0 : 1000000u)) {
                    fail(a, "connection timeout: no data from the adapter");
                    continue;
                }
                if (int64_t(now - a.nextSendUs) >= 0) {
                    std::vector<uint8_t> p;
                    put16(p, 2);  // item count
                    put16(p, ITEM_SEQUENCED_ADDRESS);
                    put16(p, 8);
                    put32(p, a.otId);
                    put32(p, ++a.encapSeq);
                    put16(p, ITEM_CONNECTED_DATA);
                    put16(p, uint16_t(2 + (a.cfg.outHeader ? 4 : 0) + a.out.size()));
                    put16(p, ++a.cipSeq);
                    if (a.cfg.outHeader) put32(p, a.running ? 1 : 0);  // run / idle
                    p.insert(p.end(), a.out.begin(), a.out.end());
                    sockaddr_in to{};
                    to.sin_family = AF_INET;
                    to.sin_port = htons(2222);
                    to.sin_addr.s_addr = a.ip;
                    if (sendto(udp_, p.data(), p.size(), 0, reinterpret_cast<sockaddr*>(&to), sizeof to) > 0) a.packetsOut++;
                    a.nextSendUs += a.otApiUs;
                    if (int64_t(now - a.nextSendUs) > int64_t(a.otApiUs)) a.nextSendUs = now + a.otApiUs;  // no burst after a stall
                }
                uint64_t left = int64_t(a.nextSendUs - now) > 0 ? a.nextSendUs - now : 0;
                if (left < wait) wait = left;
            }
        }
        pollfd pf{udp_, POLLIN, 0};
        timespec ts{time_t(wait / 1000000u), long((wait % 1000000u) * 1000u)};
        if (ppoll(&pf, 1, &ts, nullptr) <= 0) continue;
        for (;;) {
            sockaddr_in from{};
            socklen_t fl = sizeof from;
            ssize_t n = recvfrom(udp_, buf, sizeof buf, 0, reinterpret_cast<sockaddr*>(&from), &fl);
            if (n <= 0) break;
            // item count, sequenced address item (connection id, sequence), connected data item
            if (n < 20 || get16(buf) < 2 || get16(buf + 2) != ITEM_SEQUENCED_ADDRESS || get16(buf + 4) != 8) continue;
            uint32_t id = get32(buf + 6);
            if (get16(buf + 14) != ITEM_CONNECTED_DATA) continue;
            uint16_t len = get16(buf + 16);
            if (size_t(18 + len) > size_t(n) || len < 2) continue;
            const uint8_t* d = buf + 18;
            std::lock_guard<std::mutex> lock(mutex_);
            for (Adapter& a : adapters_) {
                if (a.state != State::RUNNING || a.toId != id) continue;
                if (!a.multicastGroup && from.sin_addr.s_addr != a.ip) continue;
                a.packetsIn++;
                a.lastRxUs = nowUs();
                uint16_t seq = get16(d);
                if (a.rxSeen && seq == a.lastRxSeq) break;  // same data again
                a.rxSeen = true;
                a.lastRxSeq = seq;
                size_t off = 2;
                if (a.cfg.inHeader && len >= 6) {
                    a.remoteRun = get32(d + 2) & 1;
                    off = 6;
                }
                size_t avail = len > off ? len - off : 0;
                size_t copy = avail < a.in.size() ? avail : a.in.size();
                memcpy(a.in.data(), d + off, copy);
                break;
            }
        }
    }
}

void Scanner::readInputs(uint8_t* image, uint32_t size) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (Adapter& a : adapters_) {
        const bool valid = a.state == State::RUNNING && a.rxSeen;
        for (size_t k = 0; k < a.in.size(); k++) {
            uint32_t at = a.cfg.inByte + uint32_t(k);
            if (at < size) image[at] = valid ? a.in[k] : 0;
        }
    }
}

void Scanner::writeOutputs(const uint8_t* image, uint32_t size, bool run) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (Adapter& a : adapters_) {
        for (size_t k = 0; k < a.out.size(); k++) {
            uint32_t at = a.cfg.outByte + uint32_t(k);
            a.out[k] = at < size ? image[at] : 0;
        }
        a.running = run;
    }
}

bool Scanner::ok(size_t k) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return k < adapters_.size() && adapters_[k].state == State::RUNNING && adapters_[k].rxSeen;
}

std::string Scanner::status(size_t k) const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (k >= adapters_.size()) return "";
    const Adapter& a = adapters_[k];
    std::string s = a.status;
    if (a.state == State::RUNNING) {
        if (!a.rxSeen) s += "\nwaiting for the first input data";
        if (a.cfg.inHeader && !a.remoteRun) s += "\nadapter in idle mode";
        char b[160];
        snprintf(b, sizeof b, "\npackets: %llu in, %llu out; connection losses: %llu", static_cast<unsigned long long>(a.packetsIn),
                 static_cast<unsigned long long>(a.packetsOut), static_cast<unsigned long long>(a.timeouts));
        s += b;
    }
    return s;
}

std::vector<Identity> listIdentity(uint32_t timeoutMs, const std::string& target) {
    std::vector<Identity> out;
    int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return out;
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &one, sizeof one);
    sockaddr_in to{};
    to.sin_family = AF_INET;
    to.sin_port = htons(44818);
    inet_pton(AF_INET, target.c_str(), &to.sin_addr);
    std::vector<uint8_t> msg = encap(ENCAP_LIST_IDENTITY, 0, {});
    sendto(fd, msg.data(), msg.size(), 0, reinterpret_cast<sockaddr*>(&to), sizeof to);
    const uint64_t end = nowUs() + uint64_t(timeoutMs) * 1000u;
    uint8_t buf[600];
    for (;;) {
        int64_t left = int64_t(end - nowUs());
        if (left <= 0 || !waitFd(fd, POLLIN, int(left / 1000) + 1)) break;
        sockaddr_in from{};
        socklen_t fl = sizeof from;
        ssize_t n = recvfrom(fd, buf, sizeof buf, 0, reinterpret_cast<sockaddr*>(&from), &fl);
        if (n < 24 + 2 + 4 + 34 || get16(buf) != ENCAP_LIST_IDENTITY) continue;
        const uint8_t* p = buf + 24;
        if (get16(p) < 1 || get16(p + 2) != ITEM_IDENTITY) continue;
        uint16_t len = get16(p + 4);
        const uint8_t* d = p + 6;
        if (size_t(d - buf) + len > size_t(n) || len < 33) continue;
        Identity id;
        char ip[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &from.sin_addr, ip, sizeof ip);
        id.address = ip;
        // d: protocol version (2), socket address (16), vendor, type, product, revision, status, serial, name
        id.vendorId = get16(d + 18);
        id.deviceType = get16(d + 20);
        id.productCode = get16(d + 22);
        id.revMajor = d[24];
        id.revMinor = d[25];
        id.status = get16(d + 26);
        id.serial = get32(d + 28);
        uint8_t nameLen = d[32];
        if (33u + nameLen <= len) id.productName.assign(reinterpret_cast<const char*>(d + 33), nameLen);
        out.push_back(id);
    }
    close(fd);
    return out;
}

}  // namespace vplc::enip
