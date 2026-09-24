#include "linux_platform.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#if __has_include(<linux/gpio.h>)
#include <linux/gpio.h>
#define VPLC_HAVE_GPIO 1
#endif

#include "isa.h"

namespace vplc {

namespace {
uint64_t monotonicUs() {
    timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return uint64_t(ts.tv_sec) * 1000000u + uint64_t(ts.tv_nsec) / 1000u;
}
const uint64_t startUs = monotonicUs();
}  // namespace

LinuxPlatform::LinuxPlatform(std::string dataDir, std::string gpioChip)
    : dataDir_(std::move(dataDir)), gpioChip_(std::move(gpioChip)) {
    mkdir(dataDir_.c_str(), 0755);
}

LinuxPlatform::~LinuxPlatform() { closeModules(); }

const char* LinuxPlatform::deviceType() {
#if defined(__aarch64__) || defined(__arm__)
    return "linux-arm";
#else
    return "linux";
#endif
}

uint32_t LinuxPlatform::millis() { return uint32_t((monotonicUs() - startUs) / 1000u); }
uint32_t LinuxPlatform::micros() { return uint32_t(monotonicUs() - startUs); }

void LinuxPlatform::log(const char* message) {
    time_t now = time(nullptr);
    char stamp[32];
    strftime(stamp, sizeof stamp, "%Y-%m-%dT%H:%M:%S", localtime(&now));
    printf("%s %s\n", stamp, message);
    fflush(stdout);
}

bool LinuxPlatform::clock(bool local, int64_t& ns) {
    timespec ts{};
    if (clock_gettime(CLOCK_REALTIME, &ts) != 0) return false;
    ns = int64_t(ts.tv_sec) * 1000000000LL + ts.tv_nsec;
    if (local) {
        tm lt{};
        time_t t = ts.tv_sec;
        if (localtime_r(&t, &lt)) ns += int64_t(lt.tm_gmtoff) * 1000000000LL;
    }
    return true;
}

bool LinuxPlatform::moduleOk(uint16_t index) {
    if (index >= modules_.size()) return false;
    switch (IoModule(modules_[index].info.kind)) {
        case IoModule::IO_PROFINET_DEVICE:
            return pnDevice_ && pnDevice_->running();
        case IoModule::IO_PROFINET_REMOTE:
            return pnController_ && index < pnRemoteIndex_.size() && pnController_->deviceOk(pnRemoteIndex_[index]);
        default:
            return modules_[index].ok;
    }
}

bool LinuxPlatform::storeProgram(const uint8_t* image, size_t length) {
    std::string path = dataDir_ + "/program.vplc", tmp = path + ".tmp";
    FILE* f = fopen(tmp.c_str(), "wb");
    if (!f) return false;
    bool ok = fwrite(image, 1, length, f) == length && fflush(f) == 0 && fsync(fileno(f)) == 0;
    fclose(f);
    return ok && rename(tmp.c_str(), path.c_str()) == 0;
}

size_t LinuxPlatform::loadProgram(uint8_t* buf, size_t capacity) {
    FILE* f = fopen((dataDir_ + "/program.vplc").c_str(), "rb");
    if (!f) return 0;
    size_t n = fread(buf, 1, capacity, f);
    bool tooLarge = fgetc(f) != EOF;
    fclose(f);
    return tooLarge ? 0 : n;
}

void LinuxPlatform::closeModules() {
    for (Module& m : modules_) {
        if (m.gpioFd >= 0) close(m.gpioFd);
    }
    modules_.clear();
}

void LinuxPlatform::failed(Module& m, const std::string& what) {
    if (m.ok || m.retryAt == 0) {
        char msg[200];
        snprintf(msg, sizeof msg, "I/O module %s offline: %s (retry in %us)", m.info.host[0] ? m.info.host : "gpio", what.c_str(),
                 unsigned(m.backoff / 1000));
        log(msg);
    }
    m.ok = false;
    if (m.modbus) m.modbus->close();
    m.retryAt = millis() + m.backoff;
    if (m.retryAt == 0) m.retryAt = 1;
    m.backoff = m.backoff * 2 > 30000 ? 30000 : m.backoff * 2;
    m.lastCoils.clear();
    m.lastRegs.clear();
}

bool LinuxPlatform::openGpio(Module& m, bool output) {
#ifdef VPLC_HAVE_GPIO
    int chip = open(gpioChip_.c_str(), O_RDONLY);
    if (chip < 0) return false;
    gpiohandle_request req{};
    req.lineoffsets[0] = m.info.pin;
    req.lines = 1;
    req.flags = output ? GPIOHANDLE_REQUEST_OUTPUT : GPIOHANDLE_REQUEST_INPUT;
#ifdef GPIOHANDLE_REQUEST_BIAS_PULL_UP
    if (!output && (m.info.flags & 2)) req.flags |= GPIOHANDLE_REQUEST_BIAS_PULL_UP;
#endif
    if (m.info.flags & 1) req.flags |= GPIOHANDLE_REQUEST_ACTIVE_LOW;
    snprintf(req.consumer_label, sizeof req.consumer_label, "virtualplc");
    int rc = ioctl(chip, GPIO_GET_LINEHANDLE_IOCTL, &req);
    close(chip);
    if (rc < 0) return false;
    m.gpioFd = req.fd;
    return true;
#else
    (void)m;
    (void)output;
    return false;
#endif
}

uint16_t LinuxPlatform::configureIo(const Program& program) {
    closeModules();
    IoModuleReader reader(program.ioconf);
    IoModuleInfo info;
    while (reader.next(info)) {
        Module m;
        m.info = info;
        char msg[400];
        switch (IoModule(info.kind)) {
            case IoModule::IO_MODBUS_TCP:
                m.modbus = std::make_unique<ModbusClient>(info.host, info.port, info.unit, 300);
                snprintf(msg, sizeof msg, "I/O module %u: Modbus TCP %s:%u unit %u", unsigned(modules_.size()), info.host,
                         unsigned(info.port), unsigned(info.unit));
                break;
            case IoModule::IO_GPIO_DI:
            case IoModule::IO_GPIO_DO:
                m.ok = openGpio(m, IoModule(info.kind) == IoModule::IO_GPIO_DO);
                m.supported = m.ok;
                snprintf(msg, sizeof msg, "I/O module %u: GPIO %u %s%s", unsigned(modules_.size()), unsigned(info.pin),
                         IoModule(info.kind) == IoModule::IO_GPIO_DO ? "output" : "input",
                         m.ok ? "" : " (not available on this system)");
                break;
            case IoModule::IO_IOLINK_MASTER:
                m.modbus = std::make_unique<ModbusClient>(info.host, info.port, info.unit, 300);
                snprintf(msg, sizeof msg, "I/O module %u: IO-Link master %s:%u (%u ports)", unsigned(modules_.size()), info.host,
                         unsigned(info.port), unsigned(info.portCount));
                break;
            case IoModule::IO_PROFINET_DEVICE:
                snprintf(msg, sizeof msg, "I/O module %u: PROFINET IO-Device \"%s\" on %s", unsigned(modules_.size()), info.station, info.ifname);
                break;
            case IoModule::IO_PROFINET_REMOTE:
                snprintf(msg, sizeof msg, "I/O module %u: PROFINET IO-Device \"%s\" (%s) driven by this controller", unsigned(modules_.size()),
                         info.station, info.host);
                break;
            default:
                m.supported = false;
                snprintf(msg, sizeof msg, "I/O module %u: analog GPIO is not supported on Linux", unsigned(modules_.size()));
        }
        log(msg);
        modules_.push_back(std::move(m));
    }
    if (reader.count() != modules_.size()) log("Warning: malformed I/O configuration");
    configureProfinet();
    return uint16_t(modules_.size());
}

static void setBit(uint8_t* image, uint32_t size, uint32_t byte, uint32_t bit, bool v) {
    if (byte >= size) return;
    if (v) image[byte] |= uint8_t(1u << bit);
    else image[byte] &= uint8_t(~(1u << bit));
}

void LinuxPlatform::configureProfinet() {
    // keep the running stacks when their configuration did not change (no reconnection)
    std::string deviceKey, controllerKey;
    pn::DeviceConfig dev;
    pn::ControllerConfig ctl;
    bool haveDevice = false;
    pnRemoteIndex_.assign(modules_.size(), 0);
    auto logger = [this](const std::string& text) { log(text.c_str()); };
    for (size_t k = 0; k < modules_.size(); k++) {
        const IoModuleInfo& i = modules_[k].info;
        char key[512];
        if (IoModule(i.kind) == IoModule::IO_PROFINET_DEVICE && !haveDevice) {
            haveDevice = true;
            dev.ifname = i.ifname;
            dev.stationName = i.station;
            dev.dataDir = dataDir_;
            dev.vendorId = i.vendorId;
            dev.deviceId = i.deviceId;
            dev.inByte = i.inByte;
            dev.inLength = i.inLength;
            dev.outByte = i.outByte;
            dev.outLength = i.outLength;
            dev.log = logger;
            snprintf(key, sizeof key, "%s|%s|%u|%u|%u|%u|%u|%u", i.ifname, i.station, i.vendorId, i.deviceId, i.inByte, i.inLength, i.outByte, i.outLength);
            deviceKey = key;
        } else if (IoModule(i.kind) == IoModule::IO_PROFINET_REMOTE) {
            if (!ctl.devices.empty() && ctl.ifname != i.ifname) {
                log("PROFINET: all the IO-Devices must be on the same interface");
                continue;
            }
            ctl.ifname = i.ifname;
            pn::RemoteDevice r;
            r.stationName = i.station;
            r.ip = i.host;
            r.vendorId = i.vendorId;
            r.deviceId = i.deviceId;
            r.cycleMs = i.cycleMs;
            r.watchdog = i.watchdog;
            for (uint8_t s = 0; s < i.subCount; s++) {
                const IoModuleInfo::PnSub& x = i.subs[s];
                pn::RemoteSubmodule sub{x.slot, x.subslot, x.moduleIdent, x.submoduleIdent, x.inLength, x.inByte, x.outLength, x.outByte, {}};
                const uint8_t* rec = i.recordPool + x.recordOffset;
                for (uint8_t k = 0; k < x.recordCount; k++) {
                    uint16_t index = uint16_t(rec[0] | (rec[1] << 8)), len = uint16_t(rec[2] | (rec[3] << 8));
                    sub.records.push_back({index, std::vector<uint8_t>(rec + 4, rec + 4 + len)});
                    for (uint16_t b = 0; b < len; b++) {
                        snprintf(key, sizeof key, "%02x", rec[4 + b]);
                        controllerKey += key;
                    }
                    rec += 4 + len;
                }
                r.submodules.push_back(sub);
                snprintf(key, sizeof key, "%u.%u:%x/%x:%u@%u:%u@%u;", x.slot, x.subslot, x.moduleIdent, x.submoduleIdent, x.inLength, x.inByte, x.outLength,
                         x.outByte);
                controllerKey += key;
            }
            snprintf(key, sizeof key, "|%s|%s|%s|%u|%u|%u|%u#", i.ifname, i.station, i.host, i.vendorId, i.deviceId, i.cycleMs, i.watchdog);
            controllerKey += key;
            pnRemoteIndex_[k] = uint16_t(ctl.devices.size());
            ctl.devices.push_back(r);
        }
    }
    if (haveDevice && !ctl.devices.empty() && dev.ifname == ctl.ifname) {
        log("PROFINET: IO-Device and IO-Controller on the same interface are not supported yet (IO-Controller disabled)");
        ctl.devices.clear();
        controllerKey.clear();
    }
    if (deviceKey != pnDeviceKey_) {
        pnDevice_.reset();
        pnDeviceKey_ = deviceKey;
        if (haveDevice) {
            pnDevice_ = std::make_unique<pn::Device>(dev);
            std::string err;
            if (!pnDevice_->start(err)) log(("PROFINET IO-Device: " + err).c_str());
        }
    }
    if (controllerKey != pnControllerKey_) {
        pnController_.reset();
        pnControllerKey_ = controllerKey;
        if (!ctl.devices.empty()) {
            ctl.stationName = "virtualplc";
            ctl.log = logger;
            pnController_ = std::make_unique<pn::Controller>(ctl);
            std::string err;
            if (!pnController_->start(err)) log(("PROFINET IO-Controller: " + err).c_str());
        }
    }
}

void LinuxPlatform::readInputs(uint8_t* image, uint32_t size) {
    if (pnDevice_) pnDevice_->readInputs(image, size);
    if (pnController_) pnController_->readInputs(image, size);
    uint32_t now = millis();
    for (Module& m : modules_) {
        const IoModuleInfo& i = m.info;
        if (m.modbus) {
            if (!m.ok && m.retryAt && int32_t(now - m.retryAt) < 0) continue;
            if (m.ok && i.pollMs && int32_t(now - m.nextPoll) < 0) continue;
            m.nextPoll = now + i.pollMs;
            bool ok = true;
            std::vector<bool> bits;
            std::vector<uint16_t> regs;
            const bool iolink = IoModule(i.kind) == IoModule::IO_IOLINK_MASTER;
            // IO-Link master: process data in of each port (registers, most significant byte first)
            for (uint8_t p = 0; iolink && ok && p < i.portCount; p++) {
                const IoModuleInfo::IoLinkPort& port = i.ports[p];
                if (!port.inLength) continue;
                ok = m.modbus->readRegisters(i.inFunction == 4 ? 4 : 3, port.inRegister, uint16_t((port.inLength + 1) / 2), regs);
                for (uint8_t k = 0; ok && k < port.inLength; k++) {
                    uint32_t at = port.inByte + k;
                    if (at < size) image[at] = uint8_t(k % 2 ? regs[k / 2] : regs[k / 2] >> 8);
                }
            }
            if (!iolink && i.diCount) {
                ok = m.modbus->readBits(2, 0, i.diCount, bits);
                if (ok) for (uint16_t k = 0; k < i.diCount; k++) setBit(image, size, i.diByte + k / 8u, k % 8u, bits[k]);
            }
            if (!iolink && ok && i.irCount) {
                ok = m.modbus->readRegisters(4, 0, i.irCount, regs);
                if (ok) {
                    for (uint16_t k = 0; k < i.irCount; k++) {
                        uint32_t at = i.irByte + k * 2u;
                        if (at + 1 < size) { image[at] = uint8_t(regs[k] >> 8); image[at + 1] = uint8_t(regs[k]); }
                    }
                }
            }
            if (!ok) {
                // Substitute value 0 for the inputs of a failed module (as a real PLC does)
                for (uint16_t k = 0; k < i.diCount; k++) setBit(image, size, i.diByte + k / 8u, k % 8u, false);
                for (uint16_t k = 0; k < i.irCount * 2u; k++) if (i.irByte + k < size) image[i.irByte + k] = 0;
                for (uint8_t p = 0; iolink && p < i.portCount; p++)
                    for (uint8_t k = 0; k < i.ports[p].inLength; k++) if (i.ports[p].inByte + k < size) image[i.ports[p].inByte + k] = 0;
                failed(m, m.modbus->error());
            } else if (!m.ok) {
                m.ok = true;
                m.backoff = 1000;
                char msg[400];
                snprintf(msg, sizeof msg, "I/O module %s online", i.host);
                log(msg);
            }
        }
#ifdef VPLC_HAVE_GPIO
        else if (IoModule(i.kind) == IoModule::IO_GPIO_DI && m.gpioFd >= 0) {
            gpiohandle_data data{};
            m.ok = ioctl(m.gpioFd, GPIOHANDLE_GET_LINE_VALUES_IOCTL, &data) >= 0;
            setBit(image, size, i.byte, i.bit, m.ok && data.values[0]);
        }
#endif
    }
}

void LinuxPlatform::writeOutputs(const uint8_t* image, uint32_t size) {
    if (pnDevice_) pnDevice_->writeOutputs(image, size, true);
    if (pnController_) pnController_->writeOutputs(image, size, true);
    uint32_t now = millis();
    for (Module& m : modules_) {
        const IoModuleInfo& i = m.info;
        if (m.modbus && IoModule(i.kind) == IoModule::IO_IOLINK_MASTER) {
            if (!m.ok) continue;
            // process data out of each port, written on change (and every 5 s)
            std::vector<uint16_t> all;
            for (uint8_t p = 0; p < i.portCount; p++) {
                const IoModuleInfo::IoLinkPort& port = i.ports[p];
                for (uint8_t k = 0; k < port.outLength; k += 2) {
                    uint8_t hi = port.outByte + k < size ? image[port.outByte + k] : 0;
                    uint8_t lo = k + 1 < port.outLength && port.outByte + k + 1u < size ? image[port.outByte + k + 1] : 0;
                    all.push_back(uint16_t(hi << 8 | lo));
                }
            }
            if (all.empty() || (all == m.lastRegs && now - m.lastWrite <= 5000)) continue;
            size_t at = 0;
            bool ok = true;
            for (uint8_t p = 0; ok && p < i.portCount; p++) {
                const IoModuleInfo::IoLinkPort& port = i.ports[p];
                size_t n = (port.outLength + 1u) / 2u;
                if (!n) continue;
                ok = m.modbus->writeRegisters(port.outRegister, std::vector<uint16_t>(all.begin() + long(at), all.begin() + long(at + n)));
                at += n;
            }
            if (!ok) { failed(m, m.modbus->error()); continue; }
            m.lastRegs = all;
            m.lastWrite = now;
        } else if (m.modbus) {
            if (!m.ok) continue;  // reconnection happens in readInputs
            if (i.coilCount) {
                std::vector<uint8_t> raw(image + (i.coilByte < size ? i.coilByte : size),
                                         image + (i.coilByte + (i.coilCount + 7u) / 8u < size ? i.coilByte + (i.coilCount + 7u) / 8u : size));
                // Write on change, and at least every 5 s in case the module was reset.
                if (raw != m.lastCoils || now - m.lastWrite > 5000) {
                    std::vector<bool> bits(i.coilCount);
                    for (uint16_t k = 0; k < i.coilCount; k++) bits[k] = k / 8u < raw.size() && ((raw[k / 8u] >> (k % 8u)) & 1);
                    if (!m.modbus->writeCoils(0, bits)) { failed(m, m.modbus->error()); continue; }
                    m.lastCoils = raw;
                    m.lastWrite = now;
                }
            }
            if (i.hrCount) {
                std::vector<uint16_t> regs(i.hrCount);
                for (uint16_t k = 0; k < i.hrCount; k++) {
                    uint32_t at = i.hrByte + k * 2u;
                    regs[k] = at + 1 < size ? uint16_t(image[at] << 8 | image[at + 1]) : 0;
                }
                if (regs != m.lastRegs || now - m.lastWrite > 5000) {
                    if (!m.modbus->writeRegisters(0, regs)) { failed(m, m.modbus->error()); continue; }
                    m.lastRegs = regs;
                    m.lastWrite = now;
                }
            }
        }
#ifdef VPLC_HAVE_GPIO
        else if (IoModule(i.kind) == IoModule::IO_GPIO_DO && m.gpioFd >= 0) {
            gpiohandle_data data{};
            data.values[0] = i.byte < size && ((image[i.byte] >> i.bit) & 1);
            m.ok = ioctl(m.gpioFd, GPIOHANDLE_SET_LINE_VALUES_IOCTL, &data) >= 0;
        }
#endif
    }
}

}  // namespace vplc
