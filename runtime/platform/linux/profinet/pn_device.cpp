// PROFINET IO-Device (see pn_device.h).
#include "pn_device.h"

#include <arpa/inet.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/eventfd.h>
#include <time.h>
#include <unistd.h>

#include <algorithm>
#include <fstream>

namespace vplc {
namespace pn {

namespace {

// PNIO error statuses
constexpr uint32_t ERR_CONNECT_AR = pnioStatus(0xDB, 0x81, 0x01, 0x00);      // ARBlockReq
constexpr uint32_t ERR_CONNECT_IOCR = pnioStatus(0xDB, 0x81, 0x02, 0x00);    // IOCRBlockReq
constexpr uint32_t ERR_CONNECT_BUSY = pnioStatus(0xDB, 0x81, 0x40, 0x04);    // out of AR resources
constexpr uint32_t ERR_CONTROL_AR = pnioStatus(0xDD, 0x81, 0x40, 0x03);      // unknown AR
constexpr uint32_t ERR_RELEASE_AR = pnioStatus(0xDC, 0x81, 0x40, 0x03);
constexpr uint32_t ERR_READ_INDEX = pnioStatus(0xDE, 0x80, 0xB0, 0x00);      // invalid index
constexpr uint32_t ERR_WRITE_AR = pnioStatus(0xDF, 0x80, 0xB7, 0x00);        // state conflict
constexpr uint32_t ERR_RPC_UNSUPPORTED = pnioStatus(0xDB, 0x81, 0x3F, 0x00);

constexpr size_t MAX_CSDU = 1440;

bool isIoModule(uint32_t ident, uint16_t& in, uint16_t& out) {
    uint32_t kind = (ident >> 8) & 0xFF, size = ident & 0xFF;
    if ((ident >> 16) || kind < 1 || kind > 3 || size == 0 || size > 250) return false;
    in = (kind & 1) ? uint16_t(size) : 0;
    out = (kind & 2) ? uint16_t(size) : 0;
    return true;
}

}  // namespace

bool catalogModule(uint16_t slot, uint16_t subslot, uint32_t moduleIdent, uint32_t submoduleIdent, uint16_t& inLength, uint16_t& outLength) {
    inLength = outLength = 0;
    if (slot == 0) {
        if (moduleIdent != DAP_MODULE_IDENT) return false;
        return (subslot == 1 && submoduleIdent == DAP_SUBMODULE_IDENT) || (subslot == 0x8000 && submoduleIdent == INTERFACE_SUBMODULE_IDENT) ||
               (subslot == 0x8001 && submoduleIdent == PORT_SUBMODULE_IDENT);
    }
    return subslot == 1 && moduleIdent == submoduleIdent && isIoModule(moduleIdent, inLength, outLength);
}

Device::Device(DeviceConfig config) : config_(std::move(config)) {
    fromController_.assign(config_.inLength, 0);
    toController_.assign(config_.outLength, 0);
}

Device::~Device() { stop(); }

void Device::log(const std::string& text) {
    if (config_.log) config_.log("PROFINET: " + text);
}

bool Device::start(std::string& error) {
    stop();
    if (!raw_.open(config_.ifname, error)) return false;
    if (!rpc_.open(RPC_PORT, error)) {
        raw_.close();
        return false;
    }
    wake_ = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
    serverBoot_ = uint32_t(time(nullptr));
    loadSettings();
    stop_ = false;
    thread_ = std::thread([this] { loop(); });
    log("IO-Device \"" + stationName() + "\" on " + config_.ifname + " (" + macText(raw_.mac()) + ", " + ipText(ip_.ip) + ")");
    return true;
}

void Device::stop() {
    if (thread_.joinable()) {
        stop_ = true;
        uint64_t one = 1;
        if (::write(wake_, &one, sizeof(one)) < 0) log("stop: cannot wake the PROFINET thread");
        thread_.join();
    }
    if (wake_ >= 0) close(wake_);
    wake_ = -1;
    raw_.close();
    rpc_.close();
    state_ = AR_NONE;
}

std::string Device::stationName() {
    std::lock_guard<std::mutex> lock(nameMutex_);
    return name_;
}

std::string Device::status() {
    static const char* names[] = {"no connection", "parametrization", "parametrization", "data exchange"};
    std::string s = names[state_.load()];
    if (state_.load() != AR_NONE) s += " with " + ar_.stationName;
    return s;
}

// ---------------------------------------------------------------------------
// Settings set by DCP (kept across restarts)
// ---------------------------------------------------------------------------

void Device::loadSettings() {
    std::string name = config_.stationName;
    Ipv4 saved;
    bool haveIp = false;
    if (!config_.dataDir.empty()) {
        std::ifstream f(config_.dataDir + "/profinet.conf");
        std::string line;
        while (std::getline(f, line)) {
            size_t eq = line.find('=');
            if (eq == std::string::npos) continue;
            std::string k = line.substr(0, eq), v = line.substr(eq + 1);
            if (k == "name") name = v;
            else if (k == "ip") haveIp = parseIp(v, saved.ip);
            else if (k == "mask") parseIp(v, saved.mask);
            else if (k == "gateway") parseIp(v, saved.gateway);
        }
    }
    {
        std::lock_guard<std::mutex> lock(nameMutex_);
        name_ = validStationName(name) ? name : std::string();
    }
    ip_ = interfaceIp(config_.ifname);
    if (haveIp && config_.manageIp && (saved.ip != ip_.ip || saved.mask != ip_.mask)) {
        std::string err;
        if (setInterfaceIp(config_.ifname, saved, err)) ip_ = saved;
        else log(err);
    }
}

void Device::saveSettings() {
    if (config_.dataDir.empty()) return;
    std::string path = config_.dataDir + "/profinet.conf";
    std::ofstream f(path + ".tmp");
    f << "name=" << stationName() << "\n";
    if (ip_.ip) f << "ip=" << ipText(ip_.ip) << "\nmask=" << ipText(ip_.mask) << "\ngateway=" << ipText(ip_.gateway) << "\n";
    f.close();
    if (rename((path + ".tmp").c_str(), path.c_str()) != 0) log("cannot save " + path);
}

// ---------------------------------------------------------------------------
// Process data
// ---------------------------------------------------------------------------

void Device::readInputs(uint8_t* image, uint32_t size) {
    std::lock_guard<std::mutex> lock(ioMutex_);
    for (uint32_t i = 0; i < fromController_.size() && config_.inByte + i < size; i++) image[config_.inByte + i] = fromController_[i];
}

void Device::writeOutputs(const uint8_t* image, uint32_t size, bool run) {
    std::lock_guard<std::mutex> lock(ioMutex_);
    for (uint32_t i = 0; i < toController_.size() && config_.outByte + i < size; i++) toController_[i] = image[config_.outByte + i];
    plcRun_ = run;
    lastWrite_ = nowUs();
}

// ---------------------------------------------------------------------------
// Event loop
// ---------------------------------------------------------------------------

void Device::loop() {
    std::vector<uint8_t> buf(2048);
    while (!stop_) {
        uint64_t now = nowUs();
        int64_t wait = 50000;
        if (state_ != AR_NONE && nextSend_) wait = std::min<int64_t>(wait, int64_t(nextSend_) - int64_t(now));
        if (wait < 0) wait = 0;
        pollfd fds[3] = {{raw_.fd(), POLLIN, 0}, {rpc_.fd(), POLLIN, 0}, {wake_, POLLIN, 0}};
        timespec ts{time_t(wait / 1000000), long(wait % 1000000) * 1000};
        int ready = ppoll(fds, 3, &ts, nullptr);
        if (stop_) break;
        if (ready > 0) {
            if (fds[0].revents & POLLIN)
                for (int i = 0; i < 64; i++) {
                    size_t n = raw_.receive(buf.data(), buf.size());
                    if (!n) break;
                    onFrame(buf.data(), n);
                }
            if (fds[1].revents & POLLIN)
                for (int i = 0; i < 16; i++) {
                    sockaddr_in from{};
                    size_t n = rpc_.receive(buf.data(), buf.size(), from);
                    if (!n) break;
                    onRpc(buf.data(), n, from);
                }
        }
        now = nowUs();
        if (state_ == AR_NONE) continue;
        if (nextSend_ && now >= nextSend_) {
            sendCyclic();
            uint32_t cycle = in_.cycleUs();
            nextSend_ += cycle ? cycle : 1000;
            if (nextSend_ < now) nextSend_ = now + cycle;  // late: do not burst
        }
        // watchdog of the output CR, parametrization timeout, ApplicationReady retries
        uint64_t watchdog = uint64_t(out_.cycleUs()) * (out_.watchdogFactor ? out_.watchdogFactor : 3);
        uint64_t activity = uint64_t(ar_.activityTimeout ? ar_.activityTimeout : 100) * 100000u;
        if (lastRx_ && now - lastRx_ > watchdog && state_ == AR_RUN) {
            abort("watchdog: no data from the controller");
        } else if (state_ != AR_RUN && now - connectedAt_ > activity) {
            abort("parametrization timeout");
        } else if (state_ == AR_WAIT_APPREADY_RES && now - appReadySent_ > 1000000) {
            if (++appReadyTries_ > 10) abort("no answer to ApplicationReady");
            else sendAppReady();
        }
    }
}

void Device::onFrame(const uint8_t* p, size_t n) {
    EthFrame eth;
    if (!parseEth(p, n, eth) || eth.type != ETHERTYPE_PN || eth.length < 2) return;
    const bool forUs = eth.dst == raw_.mac();
    uint16_t frameId = uint16_t((eth.payload[0] << 8) | eth.payload[1]);
    if (frameId == FRAME_DCP_IDENT_REQ || frameId == FRAME_DCP_GETSET) {
        if (!forUs && !(frameId == FRAME_DCP_IDENT_REQ && eth.dst == DCP_IDENTIFY_MULTICAST)) return;
        DcpMessage m;
        if (frameId == FRAME_DCP_GETSET && eth.length >= 12 && eth.payload[2] == DCP_GET) {
            // get request: option / suboption pairs without length
            uint16_t len = uint16_t((eth.payload[10] << 8) | eth.payload[11]);
            m.frameId = frameId;
            m.service = DCP_GET;
            m.type = eth.payload[3];
            m.xid = uint32_t((eth.payload[4] << 24) | (eth.payload[5] << 16) | (eth.payload[6] << 8) | eth.payload[7]);
            if (m.type == DCP_REQUEST && size_t(len) + 12 <= eth.length) onDcpGet(eth, m, eth.payload + 12, len);
            return;
        }
        if (parseDcp(eth.payload, eth.length, m) && m.type == DCP_REQUEST) onDcp(eth, m);
        return;
    }
    if (!forUs) return;
    if (frameId == FRAME_ALARM_HIGH || frameId == FRAME_ALARM_LOW) {
        onAlarm(eth, eth.payload + 2, eth.length - 2);
    } else if (frameId >= FRAME_RT1_FIRST && frameId <= FRAME_RT1_LAST) {
        onCyclic(frameId, eth.payload + 2, eth.length - 2);
    }
}

// ---------------------------------------------------------------------------
// DCP
// ---------------------------------------------------------------------------

void Device::addIdentityBlocks(DcpBuilder& b, bool all, const uint8_t* wanted, size_t n) {
    auto want = [&](uint8_t opt, uint8_t sub) {
        if (all) return true;
        for (size_t i = 0; i + 1 < n; i += 2)
            if ((wanted[i] == opt || wanted[i] == DCP_OPT_ALL) && (wanted[i + 1] == sub || wanted[i + 1] == DCP_OPT_ALL)) return true;
        return false;
    };
    const std::string name = stationName();
    if (want(DCP_OPT_DEVICE, DCP_DEV_VENDOR)) b.block(DCP_OPT_DEVICE, DCP_DEV_VENDOR, 0, config_.vendorName.data(), config_.vendorName.size());
    if (want(DCP_OPT_DEVICE, DCP_DEV_NAME)) b.block(DCP_OPT_DEVICE, DCP_DEV_NAME, 0, name.data(), name.size());
    if (want(DCP_OPT_DEVICE, DCP_DEV_ID)) {
        uint8_t id[4] = {uint8_t(config_.vendorId >> 8), uint8_t(config_.vendorId), uint8_t(config_.deviceId >> 8), uint8_t(config_.deviceId)};
        b.block(DCP_OPT_DEVICE, DCP_DEV_ID, 0, id, 4);
    }
    if (want(DCP_OPT_DEVICE, DCP_DEV_ROLE)) {
        uint8_t role[2] = {0x01, 0x00};  // IO-Device
        b.block(DCP_OPT_DEVICE, DCP_DEV_ROLE, 0, role, 2);
    }
    if (want(DCP_OPT_DEVICE, DCP_DEV_OPTIONS)) {
        static const uint8_t options[] = {DCP_OPT_IP, DCP_IP_MAC, DCP_OPT_IP, DCP_IP_PARAM, DCP_OPT_DEVICE, DCP_DEV_VENDOR, DCP_OPT_DEVICE, DCP_DEV_NAME,
                                          DCP_OPT_DEVICE, DCP_DEV_ID, DCP_OPT_DEVICE, DCP_DEV_ROLE, DCP_OPT_DEVICE, DCP_DEV_OPTIONS,
                                          DCP_OPT_DEVICE, DCP_DEV_INSTANCE, DCP_OPT_CONTROL, DCP_CTL_START, DCP_OPT_CONTROL, DCP_CTL_STOP,
                                          DCP_OPT_CONTROL, DCP_CTL_SIGNAL, DCP_OPT_CONTROL, DCP_CTL_RESPONSE, DCP_OPT_CONTROL, DCP_CTL_RESET_TO_FACTORY};
        b.block(DCP_OPT_DEVICE, DCP_DEV_OPTIONS, 0, options, sizeof(options));
    }
    if (want(DCP_OPT_DEVICE, DCP_DEV_INSTANCE)) {
        uint8_t instance[2] = {0x00, 0x01};
        b.block(DCP_OPT_DEVICE, DCP_DEV_INSTANCE, 0, instance, 2);
    }
    if (want(DCP_OPT_IP, DCP_IP_PARAM)) {
        uint8_t ip[12];
        uint32_t v[3] = {ip_.ip, ip_.mask, ip_.gateway};
        for (int i = 0; i < 3; i++)
            for (int k = 0; k < 4; k++) ip[i * 4 + k] = uint8_t(v[i] >> (24 - 8 * k));
        b.block(DCP_OPT_IP, DCP_IP_PARAM, ip_.ip ? 0x0001 : 0x0000, ip, 12);
    }
    if (!all && want(DCP_OPT_IP, DCP_IP_MAC)) b.block(DCP_OPT_IP, DCP_IP_MAC, 0, raw_.mac().data(), 6);
}

void Device::onDcp(const EthFrame& eth, const DcpMessage& m) {
    if (m.frameId == FRAME_DCP_IDENT_REQ && m.service == DCP_IDENTIFY) {
        const std::string name = stationName();
        for (const DcpBlock& f : m.blocks) {
            if (f.option == DCP_OPT_ALL && f.suboption == DCP_OPT_ALL) continue;
            if (f.option == DCP_OPT_DEVICE && f.suboption == DCP_DEV_NAME) {
                if (name.empty() || std::string(reinterpret_cast<const char*>(f.data), f.length) != name) return;
            } else if (f.option == DCP_OPT_DEVICE && f.suboption == DCP_DEV_ID) {
                if (f.length != 4 || ((f.data[0] << 8) | f.data[1]) != config_.vendorId || ((f.data[2] << 8) | f.data[3]) != config_.deviceId) return;
            } else if (f.option == DCP_OPT_DEVICE && f.suboption == DCP_DEV_VENDOR) {
                if (std::string(reinterpret_cast<const char*>(f.data), f.length) != config_.vendorName) return;
            } else if (f.option == DCP_OPT_DEVICE && f.suboption == DCP_DEV_ROLE) {
                if (f.length < 1 || !(f.data[0] & 0x01)) return;
            } else if (f.option == DCP_OPT_IP && f.suboption == DCP_IP_PARAM) {
                if (f.length < 4 || uint32_t((f.data[0] << 24) | (f.data[1] << 16) | (f.data[2] << 8) | f.data[3]) != ip_.ip) return;
            } else {
                return;  // filter we do not support: not us
            }
        }
        DcpBuilder b(frame_, eth.src, raw_.mac(), FRAME_DCP_IDENT_RES, DCP_IDENTIFY, DCP_RESPONSE_OK, m.xid);
        addIdentityBlocks(b, true, nullptr, 0);
        b.finish();
        raw_.send(frame_);
    } else if (m.frameId == FRAME_DCP_GETSET && m.service == DCP_SET) {
        onDcpSet(eth, m);
    }
}

void Device::onDcpGet(const EthFrame& eth, const DcpMessage& m, const uint8_t* data, size_t n) {
    DcpBuilder b(frame_, eth.src, raw_.mac(), FRAME_DCP_GETSET, DCP_GET, DCP_RESPONSE_OK, m.xid);
    addIdentityBlocks(b, false, data, n);
    b.finish();
    raw_.send(frame_);
}

void Device::onDcpSet(const EthFrame& eth, const DcpMessage& m) {
    DcpBuilder b(frame_, eth.src, raw_.mac(), FRAME_DCP_GETSET, DCP_SET, DCP_RESPONSE_OK, m.xid);
    auto result = [&](const DcpBlock& blk, uint8_t error) {
        uint8_t r[3] = {blk.option, blk.suboption, error};
        b.raw(DCP_OPT_CONTROL, DCP_CTL_RESPONSE, r, 3);
    };
    bool changed = false;
    for (const DcpBlock& blk : m.blocks) {
        if (blk.length < 2) {
            result(blk, 5);
            continue;
        }
        const uint16_t qualifier = uint16_t((blk.data[0] << 8) | blk.data[1]);
        const uint8_t* d = blk.data + 2;
        const size_t len = blk.length - 2u;
        if (blk.option == DCP_OPT_DEVICE && blk.suboption == DCP_DEV_NAME) {
            std::string name(reinterpret_cast<const char*>(d), len);
            if (!name.empty() && !validStationName(name)) {
                result(blk, 5);
                continue;
            }
            if (state_ != AR_NONE && name != stationName()) abort("name of station changed");
            {
                std::lock_guard<std::mutex> lock(nameMutex_);
                name_ = name;
            }
            log("name of station set to \"" + name + "\"");
            changed = changed || (qualifier & 1);
            result(blk, 0);
        } else if (blk.option == DCP_OPT_IP && blk.suboption == DCP_IP_PARAM) {
            if (len < 12) {
                result(blk, 5);
                continue;
            }
            Ipv4 ip;
            ip.ip = uint32_t((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]);
            ip.mask = uint32_t((d[4] << 24) | (d[5] << 16) | (d[6] << 8) | d[7]);
            ip.gateway = uint32_t((d[8] << 24) | (d[9] << 16) | (d[10] << 8) | d[11]);
            if (state_ != AR_NONE && ip.ip != ip_.ip) {
                result(blk, 6);  // in operation
                continue;
            }
            std::string err;
            if (config_.manageIp && !setInterfaceIp(config_.ifname, ip, err)) {
                log(err);
                result(blk, 4);
                continue;
            }
            ip_ = ip;
            log("IP address set to " + ipText(ip.ip) + " / " + ipText(ip.mask) + (config_.manageIp ? "" : " (not applied: managed by the system)"));
            changed = changed || (qualifier & 1);
            result(blk, 0);
        } else if (blk.option == DCP_OPT_CONTROL && (blk.suboption == DCP_CTL_START || blk.suboption == DCP_CTL_STOP)) {
            result(blk, 0);
        } else if (blk.option == DCP_OPT_CONTROL && blk.suboption == DCP_CTL_SIGNAL) {
            log("identification requested (flashing)");
            result(blk, 0);
        } else if (blk.option == DCP_OPT_CONTROL && (blk.suboption == DCP_CTL_RESET_TO_FACTORY || blk.suboption == DCP_CTL_FACTORY_RESET)) {
            if (state_ != AR_NONE) abort("reset to factory settings");
            {
                std::lock_guard<std::mutex> lock(nameMutex_);
                name_.clear();
            }
            log("reset to factory settings (name of station cleared)");
            changed = true;
            result(blk, 0);
        } else {
            result(blk, blk.option == DCP_OPT_IP || blk.option == DCP_OPT_DEVICE || blk.option == DCP_OPT_CONTROL ? 2 : 1);
        }
    }
    b.finish();
    raw_.send(frame_);
    if (changed) saveSettings();
}

// ---------------------------------------------------------------------------
// Cyclic data
// ---------------------------------------------------------------------------

void Device::sendCyclic() {
    uint8_t csdu[MAX_CSDU] = {0};
    const size_t length = std::min<size_t>(in_.dataLength, MAX_CSDU);
    bool run;
    {
        std::lock_guard<std::mutex> lock(ioMutex_);
        run = plcRun_ && nowUs() - lastWrite_ < 500000;
        for (const Mapped& m : mapped_) {
            if (!m.hasIn) continue;
            if (m.imageOut >= 0)
                for (uint16_t i = 0; i < m.inLength; i++) csdu[m.inOffset + i] = toController_[size_t(m.imageOut) + i];
            csdu[m.inIops] = run || !m.inLength ? IOXS_GOOD : IOXS_BAD;
        }
    }
    for (const IoDataObject& o : in_.iocs)
        if (o.frameOffset < length) csdu[o.frameOffset] = IOXS_GOOD;
    cycleCounter_ = uint16_t(cycleCounter_ + in_.sendClockFactor * in_.reductionRatio);
    writeRtFrame(frame_, ar_.initiatorMac, raw_.mac(), in_.tagHeader, in_.frameId, csdu, length, cycleCounter_, run ? DATA_STATUS_RUN : DATA_STATUS_STOP);
    raw_.send(frame_);
}

void Device::onCyclic(uint16_t frameId, const uint8_t* p, size_t n) {
    if (state_ == AR_NONE || frameId != out_.frameId || n < size_t(out_.dataLength) + 4) return;
    const uint8_t dataStatus = p[out_.dataLength + 2];
    const bool valid = (dataStatus & 0x04) != 0;
    const bool run = valid && (dataStatus & 0x10) != 0;
    lastRx_ = nowUs();
    std::lock_guard<std::mutex> lock(ioMutex_);
    controllerRun_ = run;
    for (const Mapped& m : mapped_) {
        if (!m.hasOut || m.imageIn < 0) continue;
        const bool good = run && state_ == AR_RUN && p[m.outIops] == IOXS_GOOD;
        for (uint16_t i = 0; i < m.outLength; i++) fromController_[size_t(m.imageIn) + i] = good ? p[m.outOffset + i] : 0;  // substitute value 0
    }
}

void Device::onAlarm(const EthFrame& eth, const uint8_t* p, size_t n) {
    // RTA-PDU: dst endpoint, src endpoint, PDU type, add flags, send / ack sequence, var part length
    if (state_ == AR_NONE || n < 12) return;
    Reader r(p, n);
    uint16_t dst = r.u16(), src = r.u16();
    uint8_t type = r.u8() & 0x0F;
    r.u8();
    uint16_t sendSeq = r.u16();
    r.u16();
    if (dst != alarmLocalRef_) return;
    if (type == 4) {  // ERR: the controller aborts the AR
        abort("aborted by the controller");
    } else if (type == 1) {  // DATA (alarm from the controller): acknowledge
        std::vector<uint8_t> f;
        Writer w(f);
        writeEthPn(w, eth.src, raw_.mac(), 0xA000);
        w.u16(FRAME_ALARM_LOW).u16(src).u16(dst).u8(0x13).u8(0x00).u16(0xFFFF).u16(sendSeq).u16(0);
        while (f.size() < 60) f.push_back(0);
        raw_.send(f);
    }
}

void Device::abort(const std::string& why) {
    if (state_ == AR_NONE) return;
    log("connection with " + ar_.stationName + " ended: " + why);
    state_ = AR_NONE;
    nextSend_ = lastRx_ = 0;
    std::lock_guard<std::mutex> lock(ioMutex_);
    std::fill(fromController_.begin(), fromController_.end(), 0);
    mapped_.clear();
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

void Device::onRpc(const uint8_t* p, size_t n, const sockaddr_in& from) {
    RpcHeader h;
    if (!parseRpc(p, n, h)) return;
    const uint8_t* body = p + RPC_HEADER_SIZE;
    if (h.type == RPC_REQUEST) {
        if ((h.flags1 & RPC_FLAG_FRAG) && !(h.flags1 & RPC_FLAG_LASTFRAG)) {
            log("fragmented RPC request not supported");
            return;
        }
        if (h.activity == lastActivity_ && h.sequence == lastSequence_ && !lastResponse_.empty()) {
            rpc_.sendTo(lastResponse_, from);  // retransmission
            return;
        }
        rpcRequest(h, body, h.bodyLength, from);
    } else if (h.type == RPC_RESPONSE && h.activity == appReadyActivity_ && state_ == AR_WAIT_APPREADY_RES) {
        NdrHeader ndr;
        const uint8_t* blocks;
        size_t length;
        std::vector<Block> list;
        if (!parseNdr(body, h.bodyLength, h.le, true, ndr, blocks, length) || !parseBlocks(blocks, length, list)) return;
        if (ndr.status != PNIO_OK) {
            abort("ApplicationReady refused by the controller");
            return;
        }
        state_ = AR_RUN;
        log("data exchange with " + ar_.stationName + " started");
    }
}

void Device::rpcRequest(const RpcHeader& h, const uint8_t* body, size_t n, const sockaddr_in& from) {
    NdrHeader ndr;
    const uint8_t* blocksData;
    size_t length;
    std::vector<Block> blocks;
    if (!parseNdr(body, n, h.le, false, ndr, blocksData, length) || !parseBlocks(blocksData, length, blocks)) return;

    std::vector<uint8_t> packet;
    Writer w(packet);
    RpcHeader r = h;
    r.type = RPC_RESPONSE;
    r.flags1 = RPC_FLAG_LASTFRAG | RPC_FLAG_NOFACK;
    r.flags2 = 0;
    r.serverBoot = serverBoot_;
    r.fragment = 0;
    writeRpc(w, r);
    size_t ndrAt = writeNdrResponse(w, 0, ndr.status, h.le);  // ndr.status = ArgsMaximum of the request
    uint32_t status;
    if (h.interface != UUID_IO_DEVICE_INTERFACE) {
        status = ERR_RPC_UNSUPPORTED;
    } else {
        switch (h.opnum) {
            case OP_CONNECT: status = connect(blocks, from, w); break;
            case OP_RELEASE: status = release(blocks, w); break;
            case OP_READ:
            case OP_READ_IMPLICIT: status = read(blocks, w); break;
            case OP_WRITE: status = write(blocks, w); break;
            case OP_CONTROL: status = control(blocks, w); break;
            default: status = ERR_RPC_UNSUPPORTED;
        }
    }
    if (status != PNIO_OK && h.opnum != OP_READ && h.opnum != OP_READ_IMPLICIT && h.opnum != OP_WRITE) packet.resize(ndrAt + NDR_HEADER_SIZE);
    w.put32(ndrAt, status);
    finishNdr(w, ndrAt, h.le);
    finishRpc(packet);
    rpc_.sendTo(packet, from);
    lastActivity_ = h.activity;
    lastSequence_ = h.sequence;
    lastResponse_ = packet;
    if (h.opnum == OP_CONTROL && status == PNIO_OK && state_ == AR_WAIT_APPREADY_RES) sendAppReady();
}

uint32_t Device::connect(const std::vector<Block>& blocks, const sockaddr_in& from, Writer& w) {
    ConnectRequest req;
    std::string error;
    if (!parseConnectRequest(blocks, req, error)) {
        log("connect refused: " + error);
        return ERR_CONNECT_AR;
    }
    if (state_ != AR_NONE) {
        if (req.ar.uuid != ar_.uuid) {
            log("connect refused: already connected to " + ar_.stationName);
            return ERR_CONNECT_BUSY;
        }
        abort("new connection of the same controller");
    }
    const IocrInfo* in = nullptr;
    const IocrInfo* out = nullptr;
    for (const IocrInfo& cr : req.iocrs) {
        if ((cr.properties & 0x0F) != 1 && (cr.properties & 0x0F) != 2) {
            log("connect refused: only RT_CLASS_1 is supported");
            return ERR_CONNECT_IOCR;
        }
        if (cr.type == IOCR_INPUT && !in) in = &cr;
        else if (cr.type == IOCR_OUTPUT && !out) out = &cr;
    }
    if (!in || !out || in->dataLength > MAX_CSDU || out->dataLength > MAX_CSDU) {
        log("connect refused: one input and one output IOCR expected");
        return ERR_CONNECT_IOCR;
    }

    ConnectResponse res;
    res.arType = req.ar.type;
    res.arUuid = req.ar.uuid;
    res.sessionKey = req.ar.sessionKey;
    res.responderMac = raw_.mac();
    // submodules: check against the catalogue and map them to the process image
    std::vector<ExpectedSubmodule> subs = req.submodules;
    std::sort(subs.begin(), subs.end(), [](const ExpectedSubmodule& a, const ExpectedSubmodule& b) {
        return a.slot != b.slot ? a.slot < b.slot : a.subslot < b.subslot;
    });
    std::vector<Mapped> mapped;
    uint32_t inPos = 0, outPos = 0;
    for (const ExpectedSubmodule& e : subs) {
        uint16_t inLen, outLen;
        const bool known = catalogModule(e.slot, e.subslot, e.moduleIdent, e.submoduleIdent, inLen, outLen);
        if (!known || inLen != e.inLength || outLen != e.outLength) {
            // wrong module: listed in the ModuleDiffBlock, not exchanged
            res.diffs.push_back({e.api, e.slot, e.moduleIdent, 1, e.subslot, e.submoduleIdent, uint16_t(0x8000 | (2 << 11))});
            log("slot " + std::to_string(e.slot) + "." + std::to_string(e.subslot) + ": unknown module 0x" + [&] {
                char s[9];
                snprintf(s, sizeof(s), "%08x", e.submoduleIdent);
                return std::string(s);
            }());
            continue;
        }
        Mapped m{};
        m.slot = e.slot;
        m.subslot = e.subslot;
        m.inLength = inLen;
        m.outLength = outLen;
        if (outLen) {
            if (outPos + outLen <= config_.inLength) m.imageIn = int32_t(outPos);
            else log("slot " + std::to_string(e.slot) + ": outside of the %I area of the device");
            outPos += outLen;
        }
        if (inLen) {
            if (inPos + inLen <= config_.outLength) m.imageOut = int32_t(inPos);
            else log("slot " + std::to_string(e.slot) + ": outside of the %Q area of the device");
            inPos += inLen;
        }
        mapped.push_back(m);
    }
    // frame offsets of the IO data objects
    for (Mapped& m : mapped) {
        for (const IoDataObject& o : in->data)
            if (o.slot == m.slot && o.subslot == m.subslot && size_t(o.frameOffset) + m.inLength < in->dataLength) {
                m.hasIn = true;
                m.inOffset = o.frameOffset;
                m.inIops = uint16_t(o.frameOffset + m.inLength);
            }
        for (const IoDataObject& o : out->data)
            if (o.slot == m.slot && o.subslot == m.subslot && m.outLength && size_t(o.frameOffset) + m.outLength < out->dataLength) {
                m.hasOut = true;
                m.outOffset = o.frameOffset;
                m.outIops = uint16_t(o.frameOffset + m.outLength);
            }
    }

    ar_ = req.ar;
    in_ = *in;
    out_ = *out;
    // the receiver of a CR chooses its frame ID: keep the controller's proposal when valid
    if (out_.frameId < FRAME_RT1_FIRST || out_.frameId > FRAME_RT1_LAST) out_.frameId = uint16_t(0xC000 + (ar_.sessionKey & 0x0FFF));
    alarmRemoteRef_ = req.alarm.localReference;
    res.iocrs.push_back({in_.type, in_.reference, in_.frameId});
    res.iocrs.push_back({out_.type, out_.reference, out_.frameId});
    res.alarmType = req.alarm.type;
    res.alarmReference = alarmLocalRef_;
    res.alarmMaxLength = std::min<uint16_t>(req.alarm.maxDataLength ? req.alarm.maxDataLength : 200, 200);
    writeConnectResponse(w, res);

    controller_ = from;
    controller_.sin_port = htons(RPC_PORT);
    {
        std::lock_guard<std::mutex> lock(ioMutex_);
        mapped_ = mapped;
        std::fill(fromController_.begin(), fromController_.end(), 0);
    }
    connectedAt_ = nowUs();
    lastRx_ = 0;
    nextSend_ = connectedAt_ + 1000;
    cycleCounter_ = 0;
    state_ = AR_WAIT_PRMEND;
    log("connected to " + ar_.stationName + " (" + ipText(ntohl(from.sin_addr.s_addr)) + "), cycle " + std::to_string(in_.cycleUs() / 1000.0).substr(0, 5) + " ms");
    return PNIO_OK;
}

uint32_t Device::control(const std::vector<Block>& blocks, Writer& w) {
    for (const Block& b : blocks) {
        ControlBlock c;
        if (b.type != BT_PRM_END_REQ || !parseControl(b, c)) continue;
        if (state_ == AR_NONE || c.arUuid != ar_.uuid || c.sessionKey != ar_.sessionKey) return ERR_CONTROL_AR;
        ControlBlock res = c;
        res.type = BT_PRM_END_RES;
        res.command = CMD_DONE;
        writeControl(w, res);
        state_ = AR_WAIT_APPREADY_RES;
        appReadyTries_ = 0;
        appReadySeq_ = 0;
        appReadyActivity_ = Uuid::random();
        return PNIO_OK;
    }
    return ERR_CONTROL_AR;
}

void Device::sendAppReady() {
    std::vector<uint8_t> packet;
    Writer w(packet);
    RpcHeader h;
    h.type = RPC_REQUEST;
    h.flags1 = RPC_FLAG_LASTFRAG | RPC_FLAG_IDEMPOTENT;
    h.object = ar_.initiatorObject;
    h.interface = UUID_IO_CONTROLLER_INTERFACE;
    h.activity = appReadyActivity_;
    h.sequence = appReadySeq_;  // same sequence for retransmissions
    h.opnum = OP_CONTROL;
    writeRpc(w, h);
    size_t ndrAt = writeNdrRequest(w, 256, h.le);
    ControlBlock c;
    c.type = BT_APP_READY_REQ;
    c.arUuid = ar_.uuid;
    c.sessionKey = ar_.sessionKey;
    c.command = CMD_APP_READY;
    writeControl(w, c);
    finishNdr(w, ndrAt, h.le);
    finishRpc(packet);
    rpc_.sendTo(packet, controller_);
    appReadySent_ = nowUs();
}

uint32_t Device::release(const std::vector<Block>& blocks, Writer& w) {
    for (const Block& b : blocks) {
        ControlBlock c;
        if (b.type != BT_RELEASE_REQ || !parseControl(b, c)) continue;
        if (state_ == AR_NONE || c.arUuid != ar_.uuid) return ERR_RELEASE_AR;
        ControlBlock res = c;
        res.type = BT_RELEASE_RES;
        res.command = CMD_DONE;
        writeControl(w, res);
        abort("released by the controller");
        return PNIO_OK;
    }
    return ERR_RELEASE_AR;
}

uint32_t Device::write(const std::vector<Block>& blocks, Writer& w) {
    // IODWriteReqHeader + data, or IODWriteMultiple (index 0xE040) with records aligned on 4 bytes
    if (blocks.empty() || blocks[0].type != BT_IOD_WRITE_REQ) return ERR_WRITE_AR;
    RecordHeader h;
    if (!parseRecordHeader(blocks[0], h)) return ERR_WRITE_AR;
    if (state_ == AR_NONE || h.arUuid != ar_.uuid) {
        writeRecordRes(w, h, ERR_WRITE_AR);
        return ERR_WRITE_AR;
    }
    if (h.index != INDEX_WRITE_MULTIPLE) {
        writeRecordRes(w, h, PNIO_OK);  // parameters are accepted (the IO modules have none)
        return PNIO_OK;
    }
    writeRecordRes(w, h, PNIO_OK);
    const uint8_t* p = blocks[0].data + blocks[0].length;
    const uint8_t* end = p + h.length;
    while (p + 64 <= end) {
        std::vector<Block> one;
        if (!parseBlocks(p, 64, one) || one.empty() || one[0].type != BT_IOD_WRITE_REQ) break;
        RecordHeader sub;
        parseRecordHeader(one[0], sub);
        writeRecordRes(w, sub, PNIO_OK);
        size_t step = 64 + sub.length;
        step = (step + 3) & ~size_t(3);
        p += step;
    }
    return PNIO_OK;
}

uint32_t Device::read(const std::vector<Block>& blocks, Writer& w) {
    if (blocks.empty() || blocks[0].type != BT_IOD_READ_REQ) return ERR_READ_INDEX;
    RecordHeader h;
    if (!parseRecordHeader(blocks[0], h)) return ERR_READ_INDEX;
    if (h.index != INDEX_IM0) {
        h.length = 0;
        writeRecordRes(w, h, ERR_READ_INDEX);
        return ERR_READ_INDEX;
    }
    std::vector<uint8_t> im0;
    Writer d(im0);
    size_t at = d.beginBlock(BT_IM0);
    std::string order = config_.orderId, serial = config_.serial;
    order.resize(20, ' ');
    serial.resize(16, ' ');
    d.u16(config_.vendorId).str(order).str(serial).u16(1).u8('V').u8(1).u8(0).u8(0).u16(0).u16(0).u16(0).u8(1).u8(1).u16(0);
    d.endBlock(at);
    h.length = uint32_t(im0.size());
    writeRecordRes(w, h, PNIO_OK);
    w.bytes(im0.data(), im0.size());
    return PNIO_OK;
}

}  // namespace pn
}  // namespace vplc
