#include "dp_master.h"

#include <asm/termbits.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/serial.h>
#include <poll.h>
#include <string.h>
#include <sys/ioctl.h>
#include <time.h>
#include <unistd.h>

namespace vplc::dp {

namespace {

constexpr uint8_t SD1 = 0x10, SD2 = 0x68, SD3 = 0xA2, SD4 = 0xDC, SC = 0xE5, ED = 0x16;
constexpr uint8_t SAP_DIAG = 60, SAP_PRM = 61, SAP_CFG = 62, SAP_MASTER = 62;
constexpr uint8_t FC_SRD_HIGH = 0x0D, FC_REQUEST = 0x40, FC_FCV = 0x10, FC_FCB = 0x20;
constexpr uint8_t FC_DL = 0x08, FC_DH = 0x0A;

uint64_t nowUs() {
    timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return uint64_t(ts.tv_sec) * 1000000u + uint64_t(ts.tv_nsec) / 1000u;
}

bool waitIn(int fd, int ms) {
    pollfd p{fd, POLLIN, 0};
    return poll(&p, 1, ms) > 0 && (p.revents & POLLIN);
}

bool readExact(int fd, uint8_t* d, size_t n, int ms) {
    while (n) {
        if (!waitIn(fd, ms)) return false;
        ssize_t r = read(fd, d, n);
        if (r <= 0) {
            if (r < 0 && (errno == EAGAIN || errno == EINTR)) continue;
            return false;
        }
        d += r;
        n -= size_t(r);
    }
    return true;
}

}  // namespace

std::vector<uint8_t> sd1(uint8_t da, uint8_t sa, uint8_t fc) {
    return {SD1, da, sa, fc, uint8_t(da + sa + fc), ED};
}

std::vector<uint8_t> sd2(uint8_t da, uint8_t sa, uint8_t fc, const std::vector<uint8_t>& data, int dsap, int ssap) {
    std::vector<uint8_t> body;
    body.push_back(uint8_t(dsap >= 0 ? da | 0x80 : da));
    body.push_back(uint8_t(ssap >= 0 ? sa | 0x80 : sa));
    body.push_back(fc);
    if (dsap >= 0) body.push_back(uint8_t(dsap));
    if (ssap >= 0) body.push_back(uint8_t(ssap));
    body.insert(body.end(), data.begin(), data.end());
    uint8_t fcs = 0;
    for (uint8_t b : body) fcs = uint8_t(fcs + b);
    std::vector<uint8_t> f{SD2, uint8_t(body.size()), uint8_t(body.size()), SD2};
    f.insert(f.end(), body.begin(), body.end());
    f.push_back(fcs);
    f.push_back(ED);
    return f;
}

void configLengths(const std::vector<uint8_t>& cfg, uint16_t& in, uint16_t& out) {
    in = out = 0;
    for (size_t k = 0; k < cfg.size(); k++) {
        uint8_t b = cfg[k];
        if (b & 0x30) {  // compact format
            uint16_t len = uint16_t((b & 0x0F) + 1) * ((b & 0x40) ? 2 : 1);
            if (b & 0x10) in = uint16_t(in + len);
            if (b & 0x20) out = uint16_t(out + len);
            continue;
        }
        if (b == 0) continue;  // empty slot
        // special format: length bytes (outputs, then inputs), then manufacturer data
        uint8_t dir = b >> 6, manufacturer = b & 0x0F;
        auto length = [&](size_t at) -> uint16_t {
            if (at >= cfg.size()) return 0;
            return uint16_t((cfg[at] & 0x3F) + 1) * ((cfg[at] & 0x40) ? 2 : 1);
        };
        size_t at = k + 1;
        if (dir == 1 || dir == 3) out = uint16_t(out + length(at++));
        if (dir == 2 || dir == 3) in = uint16_t(in + length(at++));
        k = at - 1 + manufacturer;
    }
}

std::string diagText(const std::vector<uint8_t>& d) {
    if (d.size() < 6) return "no diagnosis";
    std::string s;
    auto add = [&](const char* t) { s += (s.empty() ? "" : ", ") + std::string(t); };
    if (d[0] & 0x01) add("station not existent");
    if (d[0] & 0x02) add("station not ready");
    if (d[0] & 0x04) add("configuration fault (Chk_Cfg: modules differ from the slave)");
    if (d[0] & 0x08) add("extended diagnosis");
    if (d[0] & 0x10) add("service not supported");
    if (d[0] & 0x20) add("invalid slave response");
    if (d[0] & 0x40) add("parameter fault (Set_Prm: ident number or parameters)");
    if (d[0] & 0x80) add("locked by another master");
    if (d[1] & 0x01) add("parameters requested");
    if (d[1] & 0x02) add("static diagnosis");
    if (d[1] & 0x08) add("watchdog on");
    if (d[1] & 0x80) add("deactivated");
    char b[64];
    snprintf(b, sizeof b, "; ident 0x%04X, master %u", unsigned(d[4] << 8 | d[5]), unsigned(d[3]));
    if (d.size() > 6) {
        s += b;
        s += "; extended:";
        for (size_t k = 6; k < d.size() && k < 38; k++) {
            snprintf(b, sizeof b, " %02X", d[k]);
            s += b;
        }
        return s;
    }
    return (s.empty() ? std::string("ok") : s) + b;
}

Master::Master(BusConfig cfg, Logger log) : bus_(std::move(cfg)), log_(std::move(log)) {
    for (const SlaveConfig& c : bus_.slaves) {
        Slave s;
        s.cfg = c;
        s.in.assign(c.inLength, 0);
        s.out.assign(c.outLength, 0);
        slaves_.push_back(std::move(s));
    }
    if (!bus_.replyTimeoutMs) {
        // slot time + latency of USB adapters
        bus_.replyTimeoutMs = bus_.baud >= 187500 ? 20 : bus_.baud >= 45450 ? 40 : 100;
    }
}

Master::~Master() {
    stop_ = true;
    if (thread_.joinable()) thread_.join();
    if (fd_ >= 0) close(fd_);
}

bool Master::start(std::string& err) {
    fd_ = open(bus_.port.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
    if (fd_ < 0) {
        err = "PROFIBUS: cannot open " + bus_.port + ": " + strerror(errno);
        return false;
    }
    termios2 t{};
    if (ioctl(fd_, TCGETS2, &t) == 0) {
        t.c_iflag = 0;
        t.c_oflag = 0;
        t.c_lflag = 0;
        t.c_cflag = CS8 | PARENB | CLOCAL | CREAD | BOTHER;  // 8 bits, even parity, 1 stop bit
        t.c_ispeed = t.c_ospeed = bus_.baud;
        t.c_cc[VMIN] = 0;
        t.c_cc[VTIME] = 0;
        if (ioctl(fd_, TCSETS2, &t) != 0) {
            err = "PROFIBUS: " + bus_.port + " does not accept " + std::to_string(bus_.baud) + " bit/s with even parity";
            return false;
        }
    }
    // low latency (FTDI and other USB adapters) and RS-485 direction control when available
    serial_struct ss{};
    if (ioctl(fd_, TIOCGSERIAL, &ss) == 0) {
        ss.flags |= ASYNC_LOW_LATENCY;
        ioctl(fd_, TIOCSSERIAL, &ss);
    }
    serial_rs485 rs{};
    rs.flags = SER_RS485_ENABLED | SER_RS485_RTS_ON_SEND;
    ioctl(fd_, TIOCSRS485, &rs);
    thread_ = std::thread([this] { run(); });
    return true;
}

bool Master::readFrame(std::vector<uint8_t>& f, uint32_t timeoutMs) {
    f.clear();
    uint8_t b;
    if (!readExact(fd_, &b, 1, int(timeoutMs))) return false;
    f.push_back(b);
    const int gap = 30;  // inter-character timeout, adapters deliver in bursts
    size_t more = 0;
    switch (b) {
        case SC: return true;
        case SD1: more = 5; break;
        case SD3: more = 13; break;
        case SD4: more = 2; break;
        case SD2: {
            uint8_t h[3];
            if (!readExact(fd_, h, 3, gap) || h[0] != h[1] || h[2] != SD2 || h[0] < 3) return false;
            f.insert(f.end(), h, h + 3);
            more = size_t(h[0]) + 2;
            break;
        }
        default: return false;
    }
    size_t at = f.size();
    f.resize(at + more);
    if (!readExact(fd_, f.data() + at, more, gap)) return false;
    return f.back() == ED || b == SD4;
}

uint8_t Master::nextFc(Slave& s) {
    if (!s.fcv) return uint8_t(FC_REQUEST | FC_FCB | FC_SRD_HIGH);  // first frame: FCB = 1, FCV = 0
    return uint8_t(FC_REQUEST | FC_FCV | (s.fcb ? FC_FCB : 0) | FC_SRD_HIGH);
}

bool Master::transact(Slave& s, const std::vector<uint8_t>& frame, std::vector<uint8_t>& reply, bool& shortAck, uint8_t& fc) {
    for (int attempt = 0; attempt < 2; attempt++) {  // one retry, same frame count bit
        ioctl(fd_, TCFLSH, TCIFLUSH);
        size_t off = 0;
        while (off < frame.size()) {
            ssize_t w = write(fd_, frame.data() + off, frame.size() - off);
            if (w > 0) off += size_t(w);
            else if (errno != EAGAIN && errno != EINTR) return false;
        }
        if (bus_.echo) {
            std::vector<uint8_t> echo(frame.size());
            if (!readExact(fd_, echo.data(), echo.size(), 50)) continue;
        }
        std::vector<uint8_t> f;
        if (!readFrame(f, bus_.replyTimeoutMs)) continue;
        shortAck = f[0] == SC;
        reply.clear();
        fc = 0;
        if (f[0] == SD1) {
            if (uint8_t(f[1] + f[2] + f[3]) != f[4]) continue;
            fc = f[3];
        } else if (f[0] == SD2) {
            const uint8_t le = f[1];
            uint8_t fcs = 0;
            for (size_t k = 4; k < 4u + le; k++) fcs = uint8_t(fcs + f[k]);
            if (fcs != f[4 + le]) continue;
            uint8_t da = f[4], sa = f[5];
            fc = f[6];
            if ((da & 0x7F) != bus_.masterAddress || (sa & 0x7F) != s.cfg.station) continue;
            size_t start = 7;
            if (da & 0x80) start++;  // DSAP
            if (sa & 0x80) start++;  // SSAP
            if (start <= 4u + le) reply.assign(f.begin() + long(start), f.begin() + long(4 + le));
        } else if (!shortAck) {
            continue;
        }
        if (s.fcv) s.fcb = !s.fcb;
        else {
            s.fcv = true;
            s.fcb = false;
        }
        return true;
    }
    return false;
}

void Master::failSlave(Slave& s, const std::string& why) {
    // called with mutex_ held
    if (s.running || s.errors == 0) log_("PROFIBUS station " + std::to_string(s.cfg.station) + " (" + s.cfg.name + "): " + why);
    if (s.running) s.lost++;
    s.running = false;
    s.state = State::DIAG;
    s.fcv = false;
    s.fcb = true;
    s.errors++;
    s.status = why;
    std::fill(s.in.begin(), s.in.end(), 0);
    s.retryAtUs = nowUs() + 1000000u;
}

bool Master::poll(Slave& s) {
    const uint8_t da = s.cfg.station, sa = bus_.masterAddress;
    std::vector<uint8_t> reply;
    bool shortAck = false;
    uint8_t fc = 0;
    State state;
    std::vector<uint8_t> out;
    bool wantDiag;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (s.state != State::DATA && int64_t(nowUs() - s.retryAtUs) < 0) return false;
        state = s.state;
        out = s.out;
        wantDiag = s.wantDiag;
    }
    auto diag = [&]() -> bool {
        if (!transact(s, sd2(da, sa, nextFc(s), {}, SAP_DIAG, SAP_MASTER), reply, shortAck, fc) || reply.size() < 6) return false;
        std::lock_guard<std::mutex> lock(mutex_);
        s.lastDiag = reply;
        s.extDiag = reply[0] & 0x08;
        s.wantDiag = false;
        return true;
    };

    if (state == State::DATA && !wantDiag) {
        const std::vector<uint8_t> frame = out.empty() ? sd1(da, sa, nextFc(s)) : sd2(da, sa, nextFc(s), out);
        bool okx = transact(s, frame, reply, shortAck, fc);
        std::lock_guard<std::mutex> lock(mutex_);
        if (!okx) {
            if (++s.errors >= 3) failSlave(s, "no answer to Data_Exchange");
            return false;
        }
        s.errors = 0;
        s.cycles++;
        size_t n = reply.size() < s.in.size() ? reply.size() : s.in.size();
        memcpy(s.in.data(), reply.data(), n);
        if ((fc & 0x0F) == FC_DH) s.wantDiag = true;  // the slave has a new diagnosis
        return true;
    }
    if (state == State::DATA || state == State::DIAG || state == State::CHECK || state == State::OFFLINE) {
        if (!diag()) {
            std::lock_guard<std::mutex> lock(mutex_);
            failSlave(s, "no answer to Slave_Diag (station " + std::to_string(da) + " not on the bus?)");
            return false;
        }
        std::lock_guard<std::mutex> lock(mutex_);
        const std::vector<uint8_t>& d = s.lastDiag;
        uint16_t ident = uint16_t(d[4] << 8 | d[5]);
        if (s.cfg.identNumber && ident != s.cfg.identNumber) {
            char b[120];
            snprintf(b, sizeof b, "wrong device: ident number 0x%04X instead of 0x%04X", ident, s.cfg.identNumber);
            failSlave(s, b);
            return false;
        }
        if (state == State::CHECK) {
            if (d[0] & (0x04 | 0x40 | 0x10 | 0x80)) {
                failSlave(s, diagText(d));
                return false;
            }
            if ((d[0] & 0x02) || (d[1] & 0x01)) return true;  // not ready yet: diag again
            s.state = State::DATA;
            s.running = true;
            s.errors = 0;
            s.status = "data exchange";
            log_("PROFIBUS station " + std::to_string(da) + " (" + s.cfg.name + "): data exchange");
            return true;
        }
        if (state == State::DATA) {
            if (d[1] & 0x01) failSlave(s, "the slave asks for its parameters again (restart?)");
            return true;
        }
        s.state = State::PRM;
        return true;
    }
    if (state == State::PRM) {
        std::vector<uint8_t> prm;
        uint16_t wd10 = uint16_t((s.cfg.watchdogMs + 9) / 10);
        uint8_t f1 = 1, f2 = 1;
        if (wd10) {
            f1 = uint8_t(wd10 < 255 ? wd10 : 255);
            f2 = uint8_t((wd10 + f1 - 1) / f1);
        }
        prm.push_back(uint8_t(0x80 | (wd10 ? 0x08 : 0)));  // lock request, watchdog on
        prm.push_back(f1);
        prm.push_back(f2);
        prm.push_back(11);  // min T_SDR (bit times)
        prm.push_back(uint8_t(s.cfg.identNumber >> 8));
        prm.push_back(uint8_t(s.cfg.identNumber));
        prm.push_back(0);   // group
        prm.insert(prm.end(), s.cfg.userPrm.begin(), s.cfg.userPrm.end());
        bool okx = transact(s, sd2(da, sa, nextFc(s), prm, SAP_PRM, SAP_MASTER), reply, shortAck, fc);
        std::lock_guard<std::mutex> lock(mutex_);
        if (!okx) failSlave(s, "no answer to Set_Prm");
        else s.state = State::CFG;
        return okx;
    }
    if (state == State::CFG) {
        bool okx = transact(s, sd2(da, sa, nextFc(s), s.cfg.config, SAP_CFG, SAP_MASTER), reply, shortAck, fc);
        std::lock_guard<std::mutex> lock(mutex_);
        if (!okx) failSlave(s, "no answer to Chk_Cfg");
        else s.state = State::CHECK;
        return okx;
    }
    return false;
}

void Master::run() {
    while (!stop_) {
        uint64_t t0 = nowUs();
        for (Slave& s : slaves_) {
            if (stop_) break;
            poll(s);
        }
        cycleUs_ = nowUs() - t0;
        // keep the bus busy but give the other threads some room
        usleep(cycleUs_ < 1000 ? 1000 : 200);
    }
}

void Master::readInputs(uint8_t* image, uint32_t size) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (Slave& s : slaves_) {
        for (size_t k = 0; k < s.in.size(); k++) {
            uint32_t at = s.cfg.inByte + uint32_t(k);
            if (at < size) image[at] = s.running ? s.in[k] : 0;
        }
    }
}

void Master::writeOutputs(const uint8_t* image, uint32_t size) {
    std::lock_guard<std::mutex> lock(mutex_);
    for (Slave& s : slaves_) {
        for (size_t k = 0; k < s.out.size(); k++) {
            uint32_t at = s.cfg.outByte + uint32_t(k);
            s.out[k] = at < size ? image[at] : 0;
        }
    }
}

bool Master::ok(size_t k) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return k < slaves_.size() && slaves_[k].running;
}

bool Master::diag(size_t k) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return k < slaves_.size() && slaves_[k].extDiag;
}

std::string Master::status(size_t k) const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (k >= slaves_.size()) return "";
    const Slave& s = slaves_[k];
    char b[200];
    snprintf(b, sizeof b, "%s\nbus %s at %u bit/s, bus cycle %.1f ms; exchanges %u, losses %u", s.status.c_str(), bus_.port.c_str(), bus_.baud,
             cycleUs_ / 1000.0, s.cycles, s.lost);
    std::string out = b;
    if (!s.lastDiag.empty()) out += "\ndiagnosis: " + diagText(s.lastDiag);
    return out;
}

}  // namespace vplc::dp
