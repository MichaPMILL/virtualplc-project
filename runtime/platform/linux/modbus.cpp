#include "modbus.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

namespace vplc {

ModbusClient::ModbusClient(std::string host, uint16_t port, uint8_t unit, int timeoutMs)
    : host_(std::move(host)), port_(port), unit_(unit), timeoutMs_(timeoutMs) {}

ModbusClient::~ModbusClient() { close(); }

void ModbusClient::close() {
    if (fd_ >= 0) ::close(fd_);
    fd_ = -1;
}

bool ModbusClient::connect() {
    if (fd_ >= 0) return true;
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* res = nullptr;
    std::string port = std::to_string(port_);
    if (getaddrinfo(host_.c_str(), port.c_str(), &hints, &res) != 0 || !res) {
        error_ = "cannot resolve " + host_;
        return false;
    }
    int fd = socket(res->ai_family, SOCK_STREAM, 0);
    if (fd < 0) {
        freeaddrinfo(res);
        error_ = strerror(errno);
        return false;
    }
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    int rc = ::connect(fd, res->ai_addr, res->ai_addrlen);
    freeaddrinfo(res);
    if (rc < 0 && errno != EINPROGRESS) {
        error_ = strerror(errno);
        ::close(fd);
        return false;
    }
    pollfd p{fd, POLLOUT, 0};
    if (poll(&p, 1, timeoutMs_) <= 0) {
        error_ = "connect timeout";
        ::close(fd);
        return false;
    }
    int err = 0;
    socklen_t len = sizeof err;
    getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len);
    if (err) {
        error_ = strerror(err);
        ::close(fd);
        return false;
    }
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    fd_ = fd;
    return true;
}

bool ModbusClient::sendAll(const uint8_t* data, size_t len) {
    while (len) {
        pollfd p{fd_, POLLOUT, 0};
        if (poll(&p, 1, timeoutMs_) <= 0) { error_ = "write timeout"; return false; }
        ssize_t n = send(fd_, data, len, MSG_NOSIGNAL);
        if (n <= 0) { error_ = "write failed"; return false; }
        data += n;
        len -= size_t(n);
    }
    return true;
}

bool ModbusClient::recvAll(uint8_t* data, size_t len) {
    while (len) {
        pollfd p{fd_, POLLIN, 0};
        if (poll(&p, 1, timeoutMs_) <= 0) { error_ = "read timeout"; return false; }
        ssize_t n = recv(fd_, data, len, 0);
        if (n <= 0) { error_ = "connection closed"; return false; }
        data += n;
        len -= size_t(n);
    }
    return true;
}

bool ModbusClient::transact(const std::vector<uint8_t>& pdu, std::vector<uint8_t>& response) {
    if (!connect()) return false;
    tid_++;
    std::vector<uint8_t> adu = {uint8_t(tid_ >> 8), uint8_t(tid_), 0, 0, uint8_t((pdu.size() + 1) >> 8), uint8_t(pdu.size() + 1), unit_};
    adu.insert(adu.end(), pdu.begin(), pdu.end());
    uint8_t header[7];
    if (!sendAll(adu.data(), adu.size()) || !recvAll(header, 7)) {
        close();
        return false;
    }
    uint16_t tid = uint16_t(header[0] << 8 | header[1]);
    uint16_t len = uint16_t(header[4] << 8 | header[5]);
    if (header[2] || header[3] || len < 2 || len > 254) {
        error_ = "malformed response";
        close();
        return false;
    }
    response.resize(len - 1);
    if (!recvAll(response.data(), response.size())) {
        close();
        return false;
    }
    if (tid != tid_) {
        error_ = "transaction id mismatch";
        close();
        return false;
    }
    if (response[0] == (pdu[0] | 0x80)) {
        error_ = "exception " + std::to_string(response.size() > 1 ? response[1] : 0);
        return false;
    }
    if (response[0] != pdu[0]) {
        error_ = "unexpected function code";
        close();
        return false;
    }
    return true;
}

bool ModbusClient::readBits(uint8_t function, uint16_t start, uint16_t count, std::vector<bool>& out) {
    std::vector<uint8_t> resp;
    if (!transact({function, uint8_t(start >> 8), uint8_t(start), uint8_t(count >> 8), uint8_t(count)}, resp)) return false;
    if (resp.size() < 2 || resp[1] < (count + 7) / 8 || resp.size() < size_t(2 + resp[1])) {
        error_ = "short response";
        return false;
    }
    out.resize(count);
    for (uint16_t i = 0; i < count; i++) out[i] = (resp[2 + i / 8] >> (i % 8)) & 1;
    return true;
}

bool ModbusClient::readRegisters(uint8_t function, uint16_t start, uint16_t count, std::vector<uint16_t>& out) {
    std::vector<uint8_t> resp;
    if (!transact({function, uint8_t(start >> 8), uint8_t(start), uint8_t(count >> 8), uint8_t(count)}, resp)) return false;
    if (resp.size() < size_t(2 + count * 2)) {
        error_ = "short response";
        return false;
    }
    out.resize(count);
    for (uint16_t i = 0; i < count; i++) out[i] = uint16_t(resp[2 + i * 2] << 8 | resp[3 + i * 2]);
    return true;
}

bool ModbusClient::writeCoils(uint16_t start, const std::vector<bool>& values) {
    uint16_t count = uint16_t(values.size());
    std::vector<uint8_t> pdu = {15, uint8_t(start >> 8), uint8_t(start), uint8_t(count >> 8), uint8_t(count), uint8_t((count + 7) / 8)};
    pdu.resize(6 + (count + 7) / 8, 0);
    for (uint16_t i = 0; i < count; i++) if (values[i]) pdu[6 + i / 8] |= uint8_t(1 << (i % 8));
    std::vector<uint8_t> resp;
    return transact(pdu, resp);
}

bool ModbusClient::writeRegisters(uint16_t start, const std::vector<uint16_t>& values) {
    uint16_t count = uint16_t(values.size());
    std::vector<uint8_t> pdu = {16, uint8_t(start >> 8), uint8_t(start), uint8_t(count >> 8), uint8_t(count), uint8_t(count * 2)};
    for (uint16_t v : values) { pdu.push_back(uint8_t(v >> 8)); pdu.push_back(uint8_t(v)); }
    std::vector<uint8_t> resp;
    return transact(pdu, resp);
}

// ---------------------------------------------------------------------------

static std::vector<uint8_t> exception(uint8_t fn, uint8_t code) { return {uint8_t(fn | 0x80), code}; }

std::vector<uint8_t> modbusServe(const uint8_t* pdu, size_t len, const ModbusAreas& a) {
    if (len < 1) return {};
    uint8_t fn = pdu[0];
    if (len < 5) return exception(fn, 3);
    uint16_t addr = uint16_t(pdu[1] << 8 | pdu[2]);
    uint16_t qty = uint16_t(pdu[3] << 8 | pdu[4]);
    auto bitArea = [&](bool inputs, uint8_t*& base, uint32_t& size) {
        base = inputs ? a.i : a.m;
        size = inputs ? a.iSize : a.mSize;
    };
    switch (fn) {
        case 1:
        case 2: {
            if (qty < 1 || qty > 2000) return exception(fn, 3);
            uint8_t* base;
            uint32_t size;
            bitArea(fn == 2, base, size);
            if (uint32_t(addr) + qty > size * 8) return exception(fn, 2);
            std::vector<uint8_t> r = {fn, uint8_t((qty + 7) / 8)};
            r.resize(2 + (qty + 7) / 8, 0);
            for (uint16_t k = 0; k < qty; k++) {
                uint32_t b = addr + k;
                if ((base[b / 8] >> (b % 8)) & 1) r[2 + k / 8] |= uint8_t(1 << (k % 8));
            }
            return r;
        }
        case 3:
        case 4: {
            if (qty < 1 || qty > 125) return exception(fn, 3);
            uint8_t* base = fn == 4 ? a.i : a.m;
            uint32_t size = fn == 4 ? a.iSize : a.mSize;
            if (uint32_t(addr) * 2 + qty * 2 > size) return exception(fn, 2);
            std::vector<uint8_t> r = {fn, uint8_t(qty * 2)};
            r.insert(r.end(), base + addr * 2, base + addr * 2 + qty * 2);
            return r;
        }
        case 5: {
            if (qty != 0xFF00 && qty != 0) return exception(fn, 3);
            if (addr >= a.mSize * 8) return exception(fn, 2);
            if (qty) a.m[addr / 8] |= uint8_t(1 << (addr % 8));
            else a.m[addr / 8] &= uint8_t(~(1 << (addr % 8)));
            return std::vector<uint8_t>(pdu, pdu + 5);
        }
        case 6: {
            if (uint32_t(addr) * 2 + 2 > a.mSize) return exception(fn, 2);
            a.m[addr * 2] = pdu[3];
            a.m[addr * 2 + 1] = pdu[4];
            return std::vector<uint8_t>(pdu, pdu + 5);
        }
        case 15:
        case 16: {
            if (len < 6 || size_t(6 + pdu[5]) > len) return exception(fn, 3);
            if (fn == 15) {
                if (qty < 1 || qty > 1968 || pdu[5] != (qty + 7) / 8) return exception(fn, 3);
                if (uint32_t(addr) + qty > a.mSize * 8) return exception(fn, 2);
                for (uint16_t k = 0; k < qty; k++) {
                    uint32_t b = addr + k;
                    bool v = (pdu[6 + k / 8] >> (k % 8)) & 1;
                    if (v) a.m[b / 8] |= uint8_t(1 << (b % 8));
                    else a.m[b / 8] &= uint8_t(~(1 << (b % 8)));
                }
            } else {
                if (qty < 1 || qty > 123 || pdu[5] != qty * 2) return exception(fn, 3);
                if (uint32_t(addr) * 2 + qty * 2 > a.mSize) return exception(fn, 2);
                memcpy(a.m + addr * 2, pdu + 6, qty * 2);
            }
            return std::vector<uint8_t>(pdu, pdu + 5);
        }
        default:
            return exception(fn, 1);
    }
}

}  // namespace vplc
