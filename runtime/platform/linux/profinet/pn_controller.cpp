// PROFINET IO-Controller (see pn_controller.h).
#include "pn_controller.h"

#include <arpa/inet.h>
#include <poll.h>
#include <string.h>
#include <sys/eventfd.h>
#include <unistd.h>

#include <algorithm>
#include <random>

namespace vplc {
namespace pn {

namespace {
constexpr uint64_t SECOND = 1000000;
constexpr uint16_t CONTROLLER_DEVICE_ID = 0x0002;

/** RT_CLASS_1 reduction ratios are powers of two (1 ms send clock) */
uint16_t reductionRatio(uint16_t cycleMs) {
    uint16_t rr = 1;
    while (rr < cycleMs && rr < 512) rr = uint16_t(rr * 2);
    return rr;
}
}  // namespace

Controller::Controller(ControllerConfig config) : config_(std::move(config)) {
    for (const RemoteDevice& r : config_.devices) {
        auto d = std::make_unique<Dev>();
        d->cfg = r;
        devs_.push_back(std::move(d));
    }
}

Controller::~Controller() = default;

void Controller::log(const std::string& text) {
    if (config_.log) config_.log("PROFINET: " + text);
}

void Controller::attach(Stack& stack) {
    stack_ = &stack;
    object_ = pnObjectUuid(1, CONTROLLER_DEVICE_ID, 0);
    std::random_device rd;
    sessionKey_ = uint16_t(rd());
    for (size_t i = 0; i < devs_.size(); i++) {
        Dev& d = *devs_[i];
        d.state = S_IDENTIFY;
        d.deadline = 0;
        d.alarmLocalRef = uint16_t(1 + i);
        if (!parseIp(d.cfg.ip, d.ip)) d.ip = 0;
    }
    stack.add(this);
    log("IO-Controller on " + config_.ifname + " (" + macText(raw().mac()) + "), " + std::to_string(devs_.size()) + " device(s)");
}

// ---------------------------------------------------------------------------
// Process data
// ---------------------------------------------------------------------------

void Controller::readInputs(uint8_t* image, uint32_t size) {
    std::lock_guard<std::mutex> lock(ioMutex_);
    for (auto& d : devs_) {
        size_t pos = 0;
        for (const RemoteSubmodule& s : d->cfg.submodules) {
            for (uint16_t i = 0; i < s.inLength; i++)
                if (uint32_t(s.inByte) + i < size && pos + i < d->inputs.size()) image[s.inByte + i] = d->inputs[pos + i];
            pos += s.inLength;
        }
    }
}

void Controller::writeOutputs(const uint8_t* image, uint32_t size, bool run) {
    std::lock_guard<std::mutex> lock(ioMutex_);
    outputs_.assign(image, image + size);
    outputsSize_ = size;
    plcRun_ = run;
    lastWrite_ = nowUs();
}

bool Controller::deviceOk(size_t index) const { return index < devs_.size() && devs_[index]->state == S_RUN; }

std::string Controller::status(size_t index) const {
    std::lock_guard<std::mutex> lock(ioMutex_);
    return index < devs_.size() ? devs_[index]->status : "";
}

bool Controller::deviceDiag(size_t index) const {
    std::lock_guard<std::mutex> lock(ioMutex_);
    return index < devs_.size() && !devs_[index]->diags.empty();
}

std::string Controller::diagnostics(size_t index) const {
    std::lock_guard<std::mutex> lock(ioMutex_);
    std::string out;
    if (index >= devs_.size()) return out;
    for (const Dev::Diag& g : devs_[index]->diags) {
        char line[160];
        snprintf(line, sizeof line, "slot %u.%u%s: %s (0x%04X)", g.slot, g.subslot,
                 g.channel == 0x8000 ? "" : (" channel " + std::to_string(g.channel)).c_str(), channelErrorText(g.errorType), g.errorType);
        if (!out.empty()) out += "\n";
        out += line;
    }
    return out;
}

void Controller::onAlarm(Dev& d, const EthFrame& eth) {
    RtaHeader h;
    if (!parseRta(eth.payload + 2, eth.length - 2, h) || h.dst != d.alarmLocalRef) return;
    const bool high = eth.payload[0] == (FRAME_ALARM_HIGH >> 8);
    if (h.type == RTA_ERR) {
        lost(d, "connection aborted by the device");
        return;
    }
    if (h.type == RTA_ACK || h.type == RTA_NACK) {
        if (h.type == RTA_ACK && d.ackPending && h.ackSeq == d.rtaSendSeq) d.ackPending = false;
        if (h.type == RTA_NACK && d.ackPending) raw().send(d.ackFrame);
        return;
    }
    if (h.type != RTA_DATA) return;
    const bool repeated = h.sendSeq == d.rtaRecvSeq;
    d.rtaRecvSeq = h.sendSeq;
    // transport acknowledgement
    RtaHeader ack;
    ack.dst = d.alarmRemoteRef;
    ack.src = d.alarmLocalRef;
    ack.type = RTA_ACK;
    ack.flags = 0x01;
    ack.sendSeq = d.rtaSendSeq;
    ack.ackSeq = h.sendSeq;
    std::vector<uint8_t> f;
    writeRtaFrame(f, d.mac, raw().mac(), high, ack, nullptr, 0);
    raw().send(f);
    if (d.ackPending && h.ackSeq == d.rtaSendSeq) d.ackPending = false;
    AlarmInfo a;
    if (repeated || !parseAlarm(h.sdu, h.length, a) || (a.blockType != BT_ALARM_HIGH && a.blockType != BT_ALARM_LOW)) return;

    // diagnosis state and diagnostic buffer
    std::string text;
    char head[96];
    snprintf(head, sizeof head, "%s: slot %u.%u: ", d.cfg.stationName.c_str(), a.slot, a.subslot);
    std::vector<ChannelDiag> channels = channelDiagnoses(a);
    {
        std::lock_guard<std::mutex> lock(ioMutex_);
        for (const ChannelDiag& c : channels) {
            const bool gone = a.type == ALARM_DIAGNOSIS_DISAPPEARS || c.disappears();
            auto same = [&](const Dev::Diag& g) { return g.slot == a.slot && g.subslot == a.subslot && g.channel == c.channel && g.errorType == c.errorType; };
            d.diags.erase(std::remove_if(d.diags.begin(), d.diags.end(), same), d.diags.end());
            if (!gone) d.diags.push_back({a.slot, a.subslot, c.channel, c.errorType});
            char line[128];
            snprintf(line, sizeof line, "%s%s %s (0x%04X)", text.empty() ? "" : "; ", gone ? "diagnosis gone:" : "diagnosis:", channelErrorText(c.errorType), c.errorType);
            text += line;
        }
        if (a.type == ALARM_DIAGNOSIS_DISAPPEARS && channels.empty()) {
            d.diags.erase(std::remove_if(d.diags.begin(), d.diags.end(), [&](const Dev::Diag& g) { return g.slot == a.slot && g.subslot == a.subslot; }),
                          d.diags.end());
            text = "all diagnoses gone";
        }
    }
    if (text.empty()) {
        static const char* names[] = {"", "diagnosis", "process alarm", "pull alarm", "plug alarm", "status alarm", "update alarm"};
        text = a.type < 7 ? names[a.type] : "alarm";
        if (a.type == ALARM_PROCESS && !a.data.empty()) {
            char v[48];
            uint32_t value = 0;
            for (size_t i = 0; i < a.data.size() && i < 4; i++) value = (value << 8) | a.data[i];
            snprintf(v, sizeof v, " (value 0x%08X)", value);
            text += v;
        }
    }
    log(head + text);

    // application acknowledgement (AlarmAck) as RTA data
    std::vector<uint8_t> sdu;
    Writer w(sdu);
    AlarmInfo ackInfo = a;
    ackInfo.status = PNIO_OK;
    writeAlarmAck(w, ackInfo);
    RtaHeader data;
    data.dst = d.alarmRemoteRef;
    data.src = d.alarmLocalRef;
    data.type = RTA_DATA;
    data.flags = 0x11;
    d.rtaSendSeq = uint16_t((d.rtaSendSeq + 1) & 0x7FFF);
    data.sendSeq = d.rtaSendSeq;
    data.ackSeq = d.rtaRecvSeq;
    writeRtaFrame(d.ackFrame, d.mac, raw().mac(), high, data, sdu.data(), sdu.size());
    raw().send(d.ackFrame);
    d.ackPending = true;
    d.ackSentAt = nowUs();
    d.ackTries = 0;
}

// ---------------------------------------------------------------------------
// Event loop
// ---------------------------------------------------------------------------

uint64_t Controller::tick(uint64_t now) {
    uint64_t next = now + 20000;
    for (auto& d : devs_) {
        step(*d, now);
        if (d->state == S_RUN || d->state == S_WAIT_APPREADY || d->state == S_WAIT_PRMEND || d->state == S_WAIT_WRITE) next = std::min(next, d->nextSend);
        // retransmission of an unacknowledged AlarmAck
        if (d->ackPending && now - d->ackSentAt > 100000) {
            if (++d->ackTries > 3) {
                d->ackPending = false;
            } else {
                raw().send(d->ackFrame);
                d->ackSentAt = now;
            }
        }
    }
    return next;
}

void Controller::onStop() {
    // orderly end: release the connections
    for (auto& d : devs_)
        if (d->state == S_RUN || d->state == S_WAIT_APPREADY || d->state == S_WAIT_PRMEND || d->state == S_WAIT_WRITE) sendRequest(*d, OP_RELEASE);
}

void Controller::step(Dev& d, uint64_t now) {
    const int state = d.state;
    if ((state == S_RUN || state == S_WAIT_APPREADY || state == S_WAIT_PRMEND || state == S_WAIT_WRITE) && now >= d.nextSend) {
        sendCyclic(d);
        uint32_t cycle = d.out.cycleUs();
        d.nextSend += cycle;
        if (d.nextSend < now) d.nextSend = now + cycle;
    }
    if (state == S_RUN) {
        uint64_t watchdog = uint64_t(d.in.cycleUs()) * d.in.watchdogFactor;
        if (now - d.lastRx > watchdog) lost(d, "watchdog: no data from the device");
        return;
    }
    if (d.deadline && now < d.deadline) return;
    switch (state) {
        case S_IDENTIFY:
        case S_PAUSE:
            identify(d);
            break;
        case S_WAIT_IDENTIFY:
            d.status = "not found";
            d.state = S_PAUSE;
            d.deadline = now + 2 * SECOND;
            break;
        case S_WAIT_SET_IP:
            lost(d, "no answer to DCP set IP");
            break;
        case S_WAIT_CONNECT:
        case S_WAIT_WRITE:
        case S_WAIT_PRMEND:
            if (++d.tries <= 3) {
                rpc().sendTo(d.request, [&] {
                    sockaddr_in a{};
                    a.sin_family = AF_INET;
                    a.sin_port = htons(RPC_PORT);
                    a.sin_addr.s_addr = htonl(d.ip);
                    return a;
                }());
                d.deadline = now + SECOND;
            } else {
                lost(d, state == S_WAIT_CONNECT ? "no answer to connect" : state == S_WAIT_WRITE ? "no answer to the parameter write" : "no answer to PrmEnd");
            }
            break;
        case S_WAIT_APPREADY:
            lost(d, "no ApplicationReady from the device");
            break;
        default:
            break;
    }
}

void Controller::lost(Dev& d, const std::string& why, bool pause) {
    if (d.state == S_RUN) log(d.cfg.stationName + ": connection lost (" + why + ")");
    else if (d.status != why) log(d.cfg.stationName + ": " + why);
    {
        std::lock_guard<std::mutex> lock(ioMutex_);
        std::fill(d.inputs.begin(), d.inputs.end(), 0);
        d.status = why;
    }
    d.state = pause ? S_PAUSE : S_IDENTIFY;
    d.deadline = nowUs() + (pause ? 2 * SECOND : 0);
}

// ---------------------------------------------------------------------------
// DCP
// ---------------------------------------------------------------------------

void Controller::identify(Dev& d) {
    d.xid = uint32_t(nowUs());
    DcpBuilder b(frame_, DCP_IDENTIFY_MULTICAST, raw().mac(), FRAME_DCP_IDENT_REQ, DCP_IDENTIFY, DCP_REQUEST, d.xid, 1);
    b.raw(DCP_OPT_DEVICE, DCP_DEV_NAME, d.cfg.stationName.data(), d.cfg.stationName.size());
    b.finish();
    raw().send(frame_);
    d.state = S_WAIT_IDENTIFY;
    d.deadline = nowUs() + SECOND;
}

void Controller::setIp(Dev& d) {
    d.xid = uint32_t(nowUs());
    DcpBuilder b(frame_, d.mac, raw().mac(), FRAME_DCP_GETSET, DCP_SET, DCP_REQUEST, d.xid);
    uint8_t ip[12] = {0};
    for (int k = 0; k < 4; k++) ip[k] = uint8_t(d.ip >> (24 - 8 * k));
    // mask 255.255.255.0 unless the device already has a mask; gateway: none (= own address)
    uint32_t mask = 0xFFFFFF00;
    for (int k = 0; k < 4; k++) ip[4 + k] = uint8_t(mask >> (24 - 8 * k));
    for (int k = 0; k < 4; k++) ip[8 + k] = ip[k];
    b.block(DCP_OPT_IP, DCP_IP_PARAM, 0x0001, ip, 12);  // permanent
    b.finish();
    raw().send(frame_);
    d.state = S_WAIT_SET_IP;
    d.deadline = nowUs() + SECOND;
}

void Controller::onFrame(const uint8_t* p, size_t n) {
    EthFrame eth;
    if (!parseEth(p, n, eth) || eth.type != ETHERTYPE_PN || eth.length < 2 || eth.dst != raw().mac()) return;
    const uint16_t frameId = uint16_t((eth.payload[0] << 8) | eth.payload[1]);
    if (frameId == FRAME_DCP_IDENT_RES || frameId == FRAME_DCP_GETSET) {
        DcpMessage m;
        if (!parseDcp(eth.payload, eth.length, m) || m.type != DCP_RESPONSE_OK) return;
        for (auto& dp : devs_) {
            Dev& d = *dp;
            if (m.xid != d.xid) continue;
            if (m.service == DCP_IDENTIFY && d.state == S_WAIT_IDENTIFY) {
                const DcpBlock* name = m.find(DCP_OPT_DEVICE, DCP_DEV_NAME);
                if (!name || name->length < 2 || std::string(reinterpret_cast<const char*>(name->data) + 2, name->length - 2u) != d.cfg.stationName) continue;
                d.mac = eth.src;
                uint32_t ip = 0;
                if (const DcpBlock* b = m.find(DCP_OPT_IP, DCP_IP_PARAM))
                    if (b->length >= 6) ip = uint32_t((b->data[2] << 24) | (b->data[3] << 16) | (b->data[4] << 8) | b->data[5]);
                if (const DcpBlock* b = m.find(DCP_OPT_DEVICE, DCP_DEV_ID)) {
                    if (b->length >= 6) {
                        uint16_t vendor = uint16_t((b->data[2] << 8) | b->data[3]), device = uint16_t((b->data[4] << 8) | b->data[5]);
                        if (vendor != d.cfg.vendorId || device != d.cfg.deviceId) {
                            lost(d, "wrong device type (vendor / device ID)");
                            continue;
                        }
                    }
                }
                if (ip != d.ip) setIp(d);
                else connect(d);
            } else if (m.service == DCP_SET && d.state == S_WAIT_SET_IP) {
                const DcpBlock* r = m.find(DCP_OPT_CONTROL, DCP_CTL_RESPONSE);
                if (r && r->length >= 3 && r->data[2] != 0) {
                    lost(d, "the device refused its IP address");
                    continue;
                }
                log(d.cfg.stationName + ": IP address " + ipText(d.ip) + " assigned");
                connect(d);
            }
        }
        return;
    }
    if (frameId == FRAME_ALARM_HIGH || frameId == FRAME_ALARM_LOW) {
        for (auto& dp : devs_)
            if (dp->mac == eth.src && dp->state != S_IDENTIFY && dp->state != S_WAIT_IDENTIFY && dp->state != S_PAUSE) onAlarm(*dp, eth);
        return;
    }
    if (frameId < FRAME_RT1_FIRST || frameId > FRAME_RT1_LAST) return;
    for (auto& dp : devs_) {
        Dev& d = *dp;
        if (d.inFrameId != frameId || d.mac != eth.src) continue;
        if (d.state != S_RUN && d.state != S_WAIT_APPREADY && d.state != S_WAIT_PRMEND && d.state != S_WAIT_WRITE) return;
        const uint8_t* c = eth.payload + 2;
        if (eth.length < size_t(d.in.dataLength) + 6) return;
        const uint8_t dataStatus = c[d.in.dataLength + 2];
        const bool valid = (dataStatus & 0x04) != 0;
        d.lastRx = nowUs();
        std::lock_guard<std::mutex> lock(ioMutex_);
        size_t pos = 0;
        for (size_t i = 0; i < d.cfg.submodules.size(); i++) {
            const RemoteSubmodule& s = d.cfg.submodules[i];
            const Dev::Layout& l = d.layout[i];
            const bool good = valid && d.state == S_RUN && c[l.inIops] == IOXS_GOOD;
            for (uint16_t k = 0; k < s.inLength; k++) d.inputs[pos + k] = good ? c[l.inOffset + k] : 0;
            pos += s.inLength;
        }
        return;
    }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

void Controller::connect(Dev& d) {
    size_t devIndex = 0;
    for (size_t i = 0; i < devs_.size(); i++)
        if (devs_[i].get() == &d) devIndex = i;

    d.ar = ArInfo();
    d.ar.uuid = Uuid::random();
    d.ar.sessionKey = ++sessionKey_;
    d.ar.initiatorMac = raw().mac();
    d.ar.initiatorObject = object_;
    d.ar.activityTimeout = 100;
    d.ar.stationName = config_.stationName;

    // frame layout: input CR = data + IOPS of every submodule, then IOCS of the output data;
    // output CR = data + IOPS of the output submodules, then IOCS of every submodule
    d.layout.assign(d.cfg.submodules.size(), Dev::Layout{0, 0, 0, 0, false});
    IocrInfo in, out;
    in.type = IOCR_INPUT;
    in.reference = 1;
    out.type = IOCR_OUTPUT;
    out.reference = 2;
    uint16_t pos = 0;
    for (size_t i = 0; i < d.cfg.submodules.size(); i++) {
        const RemoteSubmodule& s = d.cfg.submodules[i];
        in.data.push_back({s.slot, s.subslot, pos});
        d.layout[i].inOffset = pos;
        d.layout[i].inIops = uint16_t(pos + s.inLength);
        pos = uint16_t(pos + s.inLength + 1);
    }
    for (const RemoteSubmodule& s : d.cfg.submodules)
        if (s.outLength) in.iocs.push_back({s.slot, s.subslot, pos++});
    in.dataLength = std::max<uint16_t>(40, pos);
    pos = 0;
    for (size_t i = 0; i < d.cfg.submodules.size(); i++) {
        const RemoteSubmodule& s = d.cfg.submodules[i];
        if (!s.outLength) continue;
        out.data.push_back({s.slot, s.subslot, pos});
        d.layout[i].outOffset = pos;
        d.layout[i].outIops = uint16_t(pos + s.outLength);
        d.layout[i].hasOut = true;
        pos = uint16_t(pos + s.outLength + 1);
    }
    for (const RemoteSubmodule& s : d.cfg.submodules) out.iocs.push_back({s.slot, s.subslot, pos++});
    out.dataLength = std::max<uint16_t>(40, pos);
    for (IocrInfo* cr : {&in, &out}) {
        cr->reductionRatio = reductionRatio(d.cfg.cycleMs ? d.cfg.cycleMs : 8);
        cr->watchdogFactor = cr->dataHoldFactor = d.cfg.watchdog ? d.cfg.watchdog : 3;
    }
    in.frameId = uint16_t(0x8000 + devIndex * 2);
    out.frameId = uint16_t(0x8001 + devIndex * 2);  // proposal, the device decides
    d.in = in;
    d.out = out;
    size_t inputBytes = 0;
    for (const RemoteSubmodule& s : d.cfg.submodules) inputBytes += s.inLength;
    {
        std::lock_guard<std::mutex> lock(ioMutex_);
        d.inputs.assign(inputBytes, 0);
    }

    d.request.clear();
    Writer w(d.request);
    RpcHeader h;
    h.object = pnObjectUuid(1, d.cfg.deviceId, d.cfg.vendorId);
    h.interface = UUID_IO_DEVICE_INTERFACE;
    h.activity = d.activity = Uuid::random();
    h.sequence = d.sequence = 0;
    h.opnum = OP_CONNECT;
    h.flags1 = RPC_FLAG_LASTFRAG | RPC_FLAG_IDEMPOTENT;
    writeRpc(w, h);
    size_t ndr = writeNdrRequest(w, 4096, h.le);
    writeArBlockReq(w, d.ar);
    writeIocrBlockReq(w, d.in);
    writeIocrBlockReq(w, d.out);
    AlarmCrInfo alarm;
    alarm.localReference = d.alarmLocalRef;
    writeAlarmCrBlockReq(w, alarm);
    std::vector<ExpectedSubmodule> expected;
    for (const RemoteSubmodule& s : d.cfg.submodules) {
        ExpectedSubmodule e;
        e.slot = s.slot;
        e.subslot = s.subslot;
        e.moduleIdent = s.moduleIdent;
        e.submoduleIdent = s.submoduleIdent;
        e.inLength = s.inLength;
        e.outLength = s.outLength;
        expected.push_back(e);
    }
    writeExpectedSubmodules(w, expected);
    finishNdr(w, ndr, h.le);
    finishRpc(d.request);
    d.tries = 0;
    d.state = S_WAIT_CONNECT;
    d.deadline = 0;  // sent by step()
    {
        std::lock_guard<std::mutex> lock(ioMutex_);
        d.status = "connecting";
    }
}

void Controller::writeRecords(Dev& d) {
    d.request.clear();
    Writer w(d.request);
    RpcHeader h;
    h.object = pnObjectUuid(1, d.cfg.deviceId, d.cfg.vendorId);
    h.interface = UUID_IO_DEVICE_INTERFACE;
    h.activity = d.activity;
    h.sequence = ++d.sequence;
    h.opnum = OP_WRITE;
    h.flags1 = RPC_FLAG_LASTFRAG | RPC_FLAG_IDEMPOTENT;
    writeRpc(w, h);
    size_t ndr = writeNdrRequest(w, 4096, h.le);
    // IODWriteMultipleReq: a header for index 0xE040, then each record aligned on 4 bytes
    RecordHeader all;
    all.type = BT_IOD_WRITE_REQ;
    all.sequence = 0;
    all.arUuid = d.ar.uuid;
    all.slot = 0xFFFF;
    all.subslot = 0xFFFF;
    all.index = INDEX_WRITE_MULTIPLE;
    size_t headerAt = w.size();
    writeRecordReq(w, all);
    size_t start = w.size();
    uint16_t seq = 1;
    for (const RemoteSubmodule& s : d.cfg.submodules) {
        for (const RemoteSubmodule::Record& r : s.records) {
            RecordHeader one;
            one.type = BT_IOD_WRITE_REQ;
            one.sequence = seq++;
            one.arUuid = d.ar.uuid;
            one.slot = s.slot;
            one.subslot = s.subslot;
            one.index = r.index;
            one.length = uint32_t(r.data.size());
            size_t at = w.size();
            writeRecordReq(w, one);
            w.bytes(r.data.data(), r.data.size());
            w.padTo(4, at);
        }
    }
    // record data length of the multiple write header (offset: block header 6 + seq 2 + AR 16 + API 4 + slot/subslot 4 + pad 2 + index 2)
    w.put32(headerAt + 6 + 2 + 16 + 4 + 4 + 2 + 2, uint32_t(w.size() - start));
    finishNdr(w, ndr, h.le);
    finishRpc(d.request);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons(RPC_PORT);
    a.sin_addr.s_addr = htonl(d.ip);
    rpc().sendTo(d.request, a);
    d.state = S_WAIT_WRITE;
    d.tries = 1;
    d.deadline = nowUs() + SECOND;
}

void Controller::sendRequest(Dev& d, uint16_t opnum) {
    d.request.clear();
    Writer w(d.request);
    RpcHeader h;
    h.object = pnObjectUuid(1, d.cfg.deviceId, d.cfg.vendorId);
    h.interface = UUID_IO_DEVICE_INTERFACE;
    h.activity = d.activity;
    h.sequence = ++d.sequence;
    h.opnum = opnum;
    h.flags1 = RPC_FLAG_LASTFRAG | RPC_FLAG_IDEMPOTENT;
    writeRpc(w, h);
    size_t ndr = writeNdrRequest(w, 4096, h.le);
    ControlBlock c;
    c.type = opnum == OP_RELEASE ? BT_RELEASE_REQ : BT_PRM_END_REQ;
    c.arUuid = d.ar.uuid;
    c.sessionKey = d.ar.sessionKey;
    c.command = opnum == OP_RELEASE ? CMD_RELEASE : CMD_PRM_END;
    writeControl(w, c);
    finishNdr(w, ndr, h.le);
    finishRpc(d.request);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons(RPC_PORT);
    a.sin_addr.s_addr = htonl(d.ip);
    rpc().sendTo(d.request, a);
    d.tries = 1;
    d.deadline = nowUs() + SECOND;
}

bool Controller::onRpc(const uint8_t* p, size_t n, const sockaddr_in& from) {
    RpcHeader h;
    if (!parseRpc(p, n, h)) return false;
    const uint8_t* body = p + RPC_HEADER_SIZE;
    if (h.type == RPC_REQUEST && h.interface == UUID_IO_CONTROLLER_INTERFACE && h.opnum == OP_CONTROL) {
        onAppReady(h, body, from);
        return true;
    }
    if (h.type != RPC_RESPONSE) return false;
    for (auto& d : devs_)
        if (d->activity == h.activity) {
            if (h.sequence == d->sequence) onRpcResponse(*d, h, body);
            return true;
        }
    return false;
}

void Controller::onRpcResponse(Dev& d, const RpcHeader& h, const uint8_t* body) {
    NdrHeader ndr;
    const uint8_t* data;
    size_t length;
    std::vector<Block> blocks;
    if (!parseNdr(body, h.bodyLength, h.le, true, ndr, data, length) || !parseBlocks(data, length, blocks)) return;
    char status[12];
    snprintf(status, sizeof(status), "%08x", ndr.status);
    if (d.state == S_WAIT_CONNECT) {
        ConnectResponse r;
        if (ndr.status != PNIO_OK || !parseConnectResponse(blocks, r)) {
            lost(d, std::string("connection refused by the device (PNIO status ") + status + ")");
            return;
        }
        d.alarmRemoteRef = r.alarmReference;
        d.rtaSendSeq = 0xFFFF;
        d.rtaRecvSeq = 0xFFFE;
        d.ackPending = false;
        {
            std::lock_guard<std::mutex> lock(ioMutex_);
            d.diags.clear();
        }
        for (const ConnectResponse::Cr& cr : r.iocrs) {
            if (cr.type == IOCR_INPUT) d.inFrameId = cr.frameId;
            if (cr.type == IOCR_OUTPUT) d.outFrameId = cr.frameId;
        }
        for (const ConnectResponse::Diff& x : r.diffs)
            log(d.cfg.stationName + ": slot " + std::to_string(x.slot) + "." + std::to_string(x.subslot) + " does not match the configuration");
        // cyclic exchange starts now (outputs with IOPS bad until the device is ready)
        d.lastRx = nowUs();
        d.nextSend = nowUs();
        d.cycleCounter = 0;
        bool records = false;
        for (const RemoteSubmodule& s : d.cfg.submodules) records = records || !s.records.empty();
        if (records) {
            writeRecords(d);
        } else {
            d.state = S_WAIT_PRMEND;
            sendRequest(d, OP_CONTROL);
        }
    } else if (d.state == S_WAIT_WRITE) {
        if (ndr.status != PNIO_OK) {
            lost(d, std::string("parameters refused by the device (PNIO status ") + status + ")");
            return;
        }
        d.state = S_WAIT_PRMEND;
        sendRequest(d, OP_CONTROL);
    } else if (d.state == S_WAIT_PRMEND) {
        if (ndr.status != PNIO_OK) {
            lost(d, std::string("PrmEnd refused by the device (PNIO status ") + status + ")");
            return;
        }
        d.state = S_WAIT_APPREADY;
        d.deadline = nowUs() + uint64_t(d.ar.activityTimeout) * 100000u;
    }
}

void Controller::onAppReady(const RpcHeader& h, const uint8_t* body, const sockaddr_in& from) {
    NdrHeader ndr;
    const uint8_t* data;
    size_t length;
    std::vector<Block> blocks;
    if (!parseNdr(body, h.bodyLength, h.le, false, ndr, data, length) || !parseBlocks(data, length, blocks)) return;
    for (const Block& b : blocks) {
        ControlBlock c;
        if (b.type != BT_APP_READY_REQ || !parseControl(b, c)) continue;
        for (auto& dp : devs_) {
            Dev& d = *dp;
            if (d.ar.uuid != c.arUuid) continue;
            std::vector<uint8_t> packet;
            Writer w(packet);
            RpcHeader r = h;
            r.type = RPC_RESPONSE;
            r.flags1 = RPC_FLAG_LASTFRAG | RPC_FLAG_NOFACK;
            writeRpc(w, r);
            size_t at = writeNdrResponse(w, PNIO_OK, ndr.status, h.le);
            ControlBlock res = c;
            res.type = BT_APP_READY_RES;
            res.command = CMD_DONE;
            writeControl(w, res);
            finishNdr(w, at, h.le);
            finishRpc(packet);
            rpc().sendTo(packet, from);
            if (d.state == S_WAIT_APPREADY || d.state == S_WAIT_PRMEND) {
                d.state = S_RUN;
                d.lastRx = nowUs();
                {
                    std::lock_guard<std::mutex> lock(ioMutex_);
                    d.status = "data exchange";
                }
                log(d.cfg.stationName + ": data exchange started (" + ipText(d.ip) + ", " + std::to_string(d.in.cycleUs() / 1000) + " ms)");
            }
            return;
        }
    }
}

void Controller::sendCyclic(Dev& d) {
    uint8_t csdu[1440] = {0};
    bool run;
    {
        std::lock_guard<std::mutex> lock(ioMutex_);
        run = plcRun_ && d.state == S_RUN && nowUs() - lastWrite_ < 500000;
        for (size_t i = 0; i < d.cfg.submodules.size(); i++) {
            const RemoteSubmodule& s = d.cfg.submodules[i];
            const Dev::Layout& l = d.layout[i];
            if (!l.hasOut) continue;
            for (uint16_t k = 0; k < s.outLength; k++)
                if (uint32_t(s.outByte) + k < outputs_.size()) csdu[l.outOffset + k] = run ? outputs_[s.outByte + k] : 0;
            csdu[l.outIops] = run ? IOXS_GOOD : IOXS_BAD;
        }
    }
    for (const IoDataObject& o : d.out.iocs)
        if (o.frameOffset < sizeof(csdu)) csdu[o.frameOffset] = IOXS_GOOD;
    d.cycleCounter = uint16_t(d.cycleCounter + d.out.sendClockFactor * d.out.reductionRatio);
    writeRtFrame(frame_, d.mac, raw().mac(), d.out.tagHeader, d.outFrameId, csdu, d.out.dataLength, d.cycleCounter,
                 run ? DATA_STATUS_RUN : DATA_STATUS_STOP);
    raw().send(frame_);
}

}  // namespace pn
}  // namespace vplc
