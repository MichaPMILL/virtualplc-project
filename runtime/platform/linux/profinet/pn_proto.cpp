// PROFINET IO protocol elements (see pn_proto.h).
#include "pn_proto.h"

#include <stdio.h>
#include <string.h>

#include <random>

namespace vplc {
namespace pn {

const Mac DCP_IDENTIFY_MULTICAST = {0x01, 0x0E, 0xCF, 0x00, 0x00, 0x00};

std::string macText(const Mac& m) {
    char s[18];
    snprintf(s, sizeof(s), "%02x:%02x:%02x:%02x:%02x:%02x", m[0], m[1], m[2], m[3], m[4], m[5]);
    return s;
}

// ---------------------------------------------------------------------------
// UUID
// ---------------------------------------------------------------------------

bool Uuid::operator==(const Uuid& o) const { return memcmp(b, o.b, 16) == 0; }

bool Uuid::isNil() const {
    for (uint8_t x : b)
        if (x) return false;
    return true;
}

std::string Uuid::text() const {
    char s[37];
    snprintf(s, sizeof(s), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x", b[0], b[1], b[2], b[3], b[4], b[5], b[6],
             b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
    return s;
}

Uuid Uuid::random() {
    static std::random_device rd;
    static std::mt19937_64 gen(rd());
    Uuid u;
    for (int i = 0; i < 16; i += 8) {
        uint64_t v = gen();
        memcpy(u.b + i, &v, 8);
    }
    u.b[6] = uint8_t((u.b[6] & 0x0F) | 0x40);  // version 4
    u.b[8] = uint8_t((u.b[8] & 0x3F) | 0x80);  // variant
    return u;
}

Uuid Uuid::parse(const char* s) {
    Uuid u;
    int n = 0;
    for (const char* p = s; *p && n < 32; p++) {
        int v = *p >= '0' && *p <= '9' ? *p - '0' : *p >= 'a' && *p <= 'f' ? *p - 'a' + 10 : *p >= 'A' && *p <= 'F' ? *p - 'A' + 10 : -1;
        if (v < 0) continue;
        u.b[n / 2] = uint8_t(u.b[n / 2] | (n % 2 ? v : v << 4));
        n++;
    }
    return u;
}

const Uuid UUID_IO_DEVICE_INTERFACE = Uuid::parse("dea00001-6c97-11d1-8271-00a02442df7d");
const Uuid UUID_IO_CONTROLLER_INTERFACE = Uuid::parse("dea00002-6c97-11d1-8271-00a02442df7d");
const Uuid UUID_EPM_INTERFACE = Uuid::parse("e1af8308-5d1f-11c9-91a4-08002b14a0fa");

Uuid pnObjectUuid(uint16_t instance, uint16_t deviceId, uint16_t vendorId) {
    Uuid u = Uuid::parse("dea00000-6c97-11d1-8271-000000000000");
    u.b[10] = uint8_t(instance >> 8);
    u.b[11] = uint8_t(instance);
    u.b[12] = uint8_t(deviceId >> 8);
    u.b[13] = uint8_t(deviceId);
    u.b[14] = uint8_t(vendorId >> 8);
    u.b[15] = uint8_t(vendorId);
    return u;
}

// ---------------------------------------------------------------------------
// Writer / Reader
// ---------------------------------------------------------------------------

Writer& Writer::bytes(const void* p, size_t n) {
    const uint8_t* b = static_cast<const uint8_t*>(p);
    out_.insert(out_.end(), b, b + n);
    return *this;
}

Writer& Writer::uuidRpc(const Uuid& u, bool le) {
    if (!le) return uuid(u);
    const uint8_t* b = u.b;
    uint8_t t[16] = {b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6]};
    memcpy(t + 8, b + 8, 8);
    return bytes(t, 16);
}

Writer& Writer::padTo(size_t align, size_t base) {
    while ((out_.size() - base) % align) out_.push_back(0);
    return *this;
}

void Writer::put32r(size_t at, uint32_t v, bool le) {
    if (le) {
        put16le(at, uint16_t(v));
        put16le(at + 2, uint16_t(v >> 16));
    } else {
        put32(at, v);
    }
}

size_t Writer::beginBlock(uint16_t type, uint8_t versionLow) {
    size_t at = out_.size();
    u16(type).u16(0).u8(1).u8(versionLow);
    return at;
}

void Writer::endBlock(size_t start) { put16(start + 2, uint16_t(out_.size() - start - 4)); }

bool Reader::need(size_t k) {
    if (!ok_ || n_ - pos_ < k) {
        ok_ = false;
        return false;
    }
    return true;
}

uint8_t Reader::u8() { return need(1) ? p_[pos_++] : 0; }

uint16_t Reader::u16() {
    if (!need(2)) return 0;
    uint16_t v = uint16_t((p_[pos_] << 8) | p_[pos_ + 1]);
    pos_ += 2;
    return v;
}

uint32_t Reader::u32() {
    uint32_t hi = u16();
    return (hi << 16) | u16();
}

uint16_t Reader::r16(bool le) {
    if (!le) return u16();
    if (!need(2)) return 0;
    uint16_t v = uint16_t(p_[pos_] | (p_[pos_ + 1] << 8));
    pos_ += 2;
    return v;
}

uint32_t Reader::r32(bool le) {
    if (!le) return u32();
    uint32_t lo = r16(true);
    return lo | (uint32_t(r16(true)) << 16);
}

Mac Reader::mac() {
    Mac m{};
    if (const uint8_t* p = take(6)) memcpy(m.data(), p, 6);
    return m;
}

Uuid Reader::uuid() {
    Uuid u;
    if (const uint8_t* p = take(16)) memcpy(u.b, p, 16);
    return u;
}

Uuid Reader::uuidRpc(bool le) {
    Uuid u = uuid();
    if (le) {
        uint8_t t[8] = {u.b[3], u.b[2], u.b[1], u.b[0], u.b[5], u.b[4], u.b[7], u.b[6]};
        memcpy(u.b, t, 8);
    }
    return u;
}

std::string Reader::str(size_t n) {
    const uint8_t* p = take(n);
    return p ? std::string(reinterpret_cast<const char*>(p), n) : std::string();
}

const uint8_t* Reader::take(size_t n) {
    if (!need(n)) return nullptr;
    const uint8_t* p = p_ + pos_;
    pos_ += n;
    return p;
}

// ---------------------------------------------------------------------------
// Ethernet
// ---------------------------------------------------------------------------

bool parseEth(const uint8_t* p, size_t n, EthFrame& out) {
    if (n < 14) return false;
    memcpy(out.dst.data(), p, 6);
    memcpy(out.src.data(), p + 6, 6);
    out.type = uint16_t((p[12] << 8) | p[13]);
    size_t off = 14;
    out.vlan = 0;
    if (out.type == ETHERTYPE_VLAN) {
        if (n < 18) return false;
        out.vlan = uint16_t((p[14] << 8) | p[15]);
        out.type = uint16_t((p[16] << 8) | p[17]);
        off = 18;
    }
    out.payload = p + off;
    out.length = n - off;
    return true;
}

void writeEthPn(Writer& w, const Mac& dst, const Mac& src, uint16_t vlan) {
    w.mac(dst).mac(src);
    if (vlan) w.u16(ETHERTYPE_VLAN).u16(vlan);
    w.u16(ETHERTYPE_PN);
}

// ---------------------------------------------------------------------------
// DCP
// ---------------------------------------------------------------------------

const DcpBlock* DcpMessage::find(uint8_t option, uint8_t suboption) const {
    for (const DcpBlock& b : blocks)
        if (b.option == option && b.suboption == suboption) return &b;
    return nullptr;
}

bool parseDcp(const uint8_t* p, size_t n, DcpMessage& out) {
    Reader r(p, n);
    out.frameId = r.u16();
    out.service = r.u8();
    out.type = r.u8();
    out.xid = r.u32();
    out.delay = r.u16();
    uint16_t length = r.u16();
    if (!r.ok() || length > r.remaining()) return false;
    Reader b(r.here(), length);
    out.blocks.clear();
    while (b.remaining() >= 4) {
        DcpBlock blk;
        blk.option = b.u8();
        blk.suboption = b.u8();
        blk.length = b.u16();
        blk.data = b.take(blk.length);
        if (!b.ok()) return false;
        out.blocks.push_back(blk);
        if (blk.length % 2 && b.remaining()) b.skip(1);
    }
    return true;
}

DcpBuilder::DcpBuilder(std::vector<uint8_t>& out, const Mac& dst, const Mac& src, uint16_t frameId, uint8_t service, uint8_t type, uint32_t xid,
                       uint16_t delay)
    : w_(out) {
    out.clear();
    writeEthPn(w_, dst, src, 0);
    w_.u16(frameId).u8(service).u8(type).u32(xid).u16(delay);
    lengthAt_ = w_.size();
    w_.u16(0);
    dataStart_ = w_.size();
}

void DcpBuilder::block(uint8_t option, uint8_t suboption, uint16_t info, const void* data, size_t n) {
    w_.u8(option).u8(suboption).u16(uint16_t(n + 2)).u16(info).bytes(data, n);
    if ((n + 2) % 2) w_.u8(0);
}

void DcpBuilder::raw(uint8_t option, uint8_t suboption, const void* data, size_t n) {
    w_.u8(option).u8(suboption).u16(uint16_t(n)).bytes(data, n);
    if (n % 2) w_.u8(0);
}

void DcpBuilder::finish() {
    w_.put16(lengthAt_, uint16_t(w_.size() - dataStart_));
    while (w_.size() < 60) w_.u8(0);
}

bool validStationName(const std::string& name) {
    if (name.empty() || name.size() > 240) return false;
    size_t label = 0;
    for (size_t i = 0; i < name.size(); i++) {
        char c = name[i];
        if (c == '.') {
            if (label == 0 || name[i - 1] == '-') return false;
            label = 0;
            continue;
        }
        bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
        if (!ok || (c == '-' && label == 0) || ++label > 63) return false;
    }
    if (label == 0 || name.back() == '-') return false;
    // "port-xyz" and IP address look-alikes are reserved
    if (name.compare(0, 5, "port-") == 0) return false;
    unsigned a, b, c, d;
    char tail;
    if (sscanf(name.c_str(), "%u.%u.%u.%u%c", &a, &b, &c, &d, &tail) == 4) return false;
    return true;
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

bool parseRpc(const uint8_t* p, size_t n, RpcHeader& h) {
    if (n < RPC_HEADER_SIZE || p[0] != 4) return false;
    h.type = p[1];
    h.flags1 = p[2];
    h.flags2 = p[3];
    h.le = (p[4] & 0xF0) == 0x10;
    h.serialHigh = p[7];
    Reader r(p + 8, n - 8);
    h.object = r.uuidRpc(h.le);
    h.interface = r.uuidRpc(h.le);
    h.activity = r.uuidRpc(h.le);
    h.serverBoot = r.r32(h.le);
    h.interfaceVersion = r.r32(h.le);
    h.sequence = r.r32(h.le);
    h.opnum = r.r16(h.le);
    h.interfaceHint = r.r16(h.le);
    h.activityHint = r.r16(h.le);
    h.bodyLength = r.r16(h.le);
    h.fragment = r.r16(h.le);
    r.u8();  // authentication protocol
    h.serialLow = r.u8();
    return r.ok() && size_t(h.bodyLength) <= n - RPC_HEADER_SIZE;
}

void writeRpc(Writer& w, const RpcHeader& h) {
    w.u8(4).u8(h.type).u8(h.flags1).u8(h.flags2).u8(h.le ? 0x10 : 0x00).u8(0).u8(0).u8(h.serialHigh);
    w.uuidRpc(h.object, h.le).uuidRpc(h.interface, h.le).uuidRpc(h.activity, h.le);
    w.r32(h.serverBoot, h.le).r32(h.interfaceVersion, h.le).r32(h.sequence, h.le);
    w.r16(h.opnum, h.le).r16(h.interfaceHint, h.le).r16(h.activityHint, h.le).r16(0, h.le).r16(h.fragment, h.le);
    w.u8(0).u8(h.serialLow);
}

void finishRpc(std::vector<uint8_t>& packet) {
    const bool le = (packet[4] & 0xF0) == 0x10;
    uint16_t length = uint16_t(packet.size() - RPC_HEADER_SIZE);
    packet[74] = le ? uint8_t(length) : uint8_t(length >> 8);
    packet[75] = le ? uint8_t(length >> 8) : uint8_t(length);
}

bool parseNdr(const uint8_t* body, size_t n, bool le, bool response, NdrHeader& out, const uint8_t*& blocks, size_t& blocksLength) {
    Reader r(body, n);
    out.status = response ? r.u32() : r.r32(le);
    out.argsLength = r.r32(le);
    out.maximumCount = r.r32(le);
    out.offset = r.r32(le);
    out.actualCount = r.r32(le);
    if (!r.ok()) return false;
    blocks = r.here();
    blocksLength = out.actualCount < r.remaining() ? out.actualCount : r.remaining();
    return true;
}

size_t writeNdrRequest(Writer& w, uint32_t argsMaximum, bool le) {
    size_t at = w.size();
    w.r32(argsMaximum, le).r32(0, le).r32(argsMaximum, le).r32(0, le).r32(0, le);
    return at;
}

size_t writeNdrResponse(Writer& w, uint32_t status, uint32_t maximumCount, bool le) {
    size_t at = w.size();
    w.u32(status).r32(0, le).r32(maximumCount, le).r32(0, le).r32(0, le);
    return at;
}

void finishNdr(Writer& w, size_t at, bool le) {
    uint32_t length = uint32_t(w.size() - at - NDR_HEADER_SIZE);
    w.put32r(at + 4, length, le);
    w.put32r(at + 16, length, le);
}

bool parseBlocks(const uint8_t* p, size_t n, std::vector<Block>& out) {
    Reader r(p, n);
    out.clear();
    while (r.remaining() >= 6) {
        Block b;
        b.type = r.u16();
        uint16_t length = r.u16();
        if (length < 2) return false;
        b.versionHigh = r.u8();
        b.versionLow = r.u8();
        b.length = length - 2;
        b.data = r.take(b.length);
        if (!r.ok()) return false;
        out.push_back(b);
    }
    return true;
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

static bool parseIocr(const Block& b, IocrInfo& cr) {
    Reader r(b.data, b.length);
    cr.type = r.u16();
    cr.reference = r.u16();
    cr.lt = r.u16();
    cr.properties = r.u32();
    cr.dataLength = r.u16();
    cr.frameId = r.u16();
    cr.sendClockFactor = r.u16();
    cr.reductionRatio = r.u16();
    cr.phase = r.u16();
    cr.sequence = r.u16();
    cr.frameSendOffset = r.u32();
    cr.watchdogFactor = r.u16();
    cr.dataHoldFactor = r.u16();
    cr.tagHeader = r.u16();
    cr.multicast = r.mac();
    uint16_t apis = r.u16();
    for (uint16_t a = 0; a < apis && r.ok(); a++) {
        cr.api = r.u32();
        uint16_t objects = r.u16();
        for (uint16_t i = 0; i < objects && r.ok(); i++) {
            IoDataObject o;
            o.slot = r.u16();
            o.subslot = r.u16();
            o.frameOffset = r.u16();
            cr.data.push_back(o);
        }
        uint16_t iocs = r.u16();
        for (uint16_t i = 0; i < iocs && r.ok(); i++) {
            IoDataObject o;
            o.slot = r.u16();
            o.subslot = r.u16();
            o.frameOffset = r.u16();
            cr.iocs.push_back(o);
        }
    }
    return r.ok();
}

bool parseConnectRequest(const std::vector<Block>& blocks, ConnectRequest& out, std::string& error) {
    bool haveAr = false;
    for (const Block& b : blocks) {
        Reader r(b.data, b.length);
        switch (b.type) {
            case BT_AR_REQ: {
                ArInfo& a = out.ar;
                a.type = r.u16();
                a.uuid = r.uuid();
                a.sessionKey = r.u16();
                a.initiatorMac = r.mac();
                a.initiatorObject = r.uuid();
                a.properties = r.u32();
                a.activityTimeout = r.u16();
                a.initiatorUdpPort = r.u16();
                uint16_t len = r.u16();
                a.stationName = r.str(len);
                if (!r.ok()) return error = "ARBlockReq malformed", false;
                haveAr = true;
                break;
            }
            case BT_IOCR_REQ: {
                IocrInfo cr;
                if (!parseIocr(b, cr)) return error = "IOCRBlockReq malformed", false;
                out.iocrs.push_back(cr);
                break;
            }
            case BT_ALARMCR_REQ: {
                AlarmCrInfo& a = out.alarm;
                a.type = r.u16();
                a.lt = r.u16();
                a.properties = r.u32();
                a.rtaTimeoutFactor = r.u16();
                a.rtaRetries = r.u16();
                a.localReference = r.u16();
                a.maxDataLength = r.u16();
                a.tagHigh = r.u16();
                a.tagLow = r.u16();
                if (!r.ok()) return error = "AlarmCRBlockReq malformed", false;
                out.haveAlarm = true;
                break;
            }
            case BT_EXPECTED_SUBMODULE: {
                uint16_t apis = r.u16();
                for (uint16_t a = 0; a < apis && r.ok(); a++) {
                    uint32_t api = r.u32();
                    uint16_t slot = r.u16();
                    uint32_t moduleIdent = r.u32();
                    r.u16();  // module properties
                    uint16_t subs = r.u16();
                    for (uint16_t s = 0; s < subs && r.ok(); s++) {
                        ExpectedSubmodule e;
                        e.api = api;
                        e.slot = slot;
                        e.moduleIdent = moduleIdent;
                        e.subslot = r.u16();
                        e.submoduleIdent = r.u32();
                        e.properties = r.u16();
                        int descriptions = (e.properties & 3) == 3 ? 2 : 1;
                        for (int d = 0; d < descriptions; d++) {
                            uint16_t kind = r.u16();
                            uint16_t length = r.u16();
                            r.u8();  // length IOCS
                            r.u8();  // length IOPS
                            if ((kind & 3) == 2) e.outLength = length;
                            else e.inLength = length;
                        }
                        out.submodules.push_back(e);
                    }
                }
                if (!r.ok()) return error = "ExpectedSubmoduleBlockReq malformed", false;
                break;
            }
            default:
                break;  // PrmServerBlock, MCRBlockReq, ARRPCBlockReq…: not used
        }
    }
    if (!haveAr) return error = "ARBlockReq missing", false;
    return true;
}

void writeArBlockReq(Writer& w, const ArInfo& a) {
    size_t at = w.beginBlock(BT_AR_REQ);
    w.u16(a.type).uuid(a.uuid).u16(a.sessionKey).mac(a.initiatorMac).uuid(a.initiatorObject).u32(a.properties);
    w.u16(a.activityTimeout).u16(a.initiatorUdpPort).u16(uint16_t(a.stationName.size())).str(a.stationName);
    w.endBlock(at);
}

void writeIocrBlockReq(Writer& w, const IocrInfo& cr) {
    size_t at = w.beginBlock(BT_IOCR_REQ);
    w.u16(cr.type).u16(cr.reference).u16(cr.lt).u32(cr.properties).u16(cr.dataLength).u16(cr.frameId);
    w.u16(cr.sendClockFactor).u16(cr.reductionRatio).u16(cr.phase).u16(cr.sequence).u32(cr.frameSendOffset);
    w.u16(cr.watchdogFactor).u16(cr.dataHoldFactor).u16(cr.tagHeader).mac(cr.multicast);
    w.u16(1).u32(cr.api).u16(uint16_t(cr.data.size()));
    for (const IoDataObject& o : cr.data) w.u16(o.slot).u16(o.subslot).u16(o.frameOffset);
    w.u16(uint16_t(cr.iocs.size()));
    for (const IoDataObject& o : cr.iocs) w.u16(o.slot).u16(o.subslot).u16(o.frameOffset);
    w.endBlock(at);
}

void writeAlarmCrBlockReq(Writer& w, const AlarmCrInfo& a) {
    size_t at = w.beginBlock(BT_ALARMCR_REQ);
    w.u16(a.type).u16(a.lt).u32(a.properties).u16(a.rtaTimeoutFactor).u16(a.rtaRetries).u16(a.localReference);
    w.u16(a.maxDataLength).u16(a.tagHigh).u16(a.tagLow);
    w.endBlock(at);
}

void writeExpectedSubmodules(Writer& w, const std::vector<ExpectedSubmodule>& subs) {
    for (size_t i = 0; i < subs.size();) {
        size_t j = i;
        while (j < subs.size() && subs[j].slot == subs[i].slot) j++;
        size_t at = w.beginBlock(BT_EXPECTED_SUBMODULE);
        w.u16(1).u32(subs[i].api).u16(subs[i].slot).u32(subs[i].moduleIdent).u16(0).u16(uint16_t(j - i));
        for (size_t k = i; k < j; k++) {
            const ExpectedSubmodule& e = subs[k];
            uint16_t kind = e.inLength && e.outLength ? 3 : e.outLength ? 2 : e.inLength ? 1 : 0;
            w.u16(e.subslot).u32(e.submoduleIdent).u16(uint16_t((e.properties & ~3) | kind));
            if (kind == 3) {
                w.u16(1).u16(e.inLength).u8(1).u8(1);
                w.u16(2).u16(e.outLength).u8(1).u8(1);
            } else {
                w.u16(kind == 2 ? 2 : 1).u16(kind == 2 ? e.outLength : e.inLength).u8(1).u8(1);
            }
        }
        w.endBlock(at);
        i = j;
    }
}

void writeConnectResponse(Writer& w, const ConnectResponse& r) {
    size_t at = w.beginBlock(BT_AR_RES);
    w.u16(r.arType).uuid(r.arUuid).u16(r.sessionKey).mac(r.responderMac).u16(r.responderUdpPort);
    w.endBlock(at);
    for (const ConnectResponse::Cr& cr : r.iocrs) {
        at = w.beginBlock(BT_IOCR_RES);
        w.u16(cr.type).u16(cr.reference).u16(cr.frameId);
        w.endBlock(at);
    }
    at = w.beginBlock(BT_ALARMCR_RES);
    w.u16(r.alarmType).u16(r.alarmReference).u16(r.alarmMaxLength);
    w.endBlock(at);
    if (!r.diffs.empty()) {
        at = w.beginBlock(BT_MODULE_DIFF);
        w.u16(1).u32(r.diffs[0].api);
        // modules (consecutive entries of the same slot share the module)
        std::vector<size_t> starts;
        for (size_t i = 0; i < r.diffs.size(); i++)
            if (i == 0 || r.diffs[i].slot != r.diffs[i - 1].slot) starts.push_back(i);
        w.u16(uint16_t(starts.size()));
        for (size_t s = 0; s < starts.size(); s++) {
            size_t i = starts[s], j = s + 1 < starts.size() ? starts[s + 1] : r.diffs.size();
            w.u16(r.diffs[i].slot).u32(r.diffs[i].moduleIdent).u16(r.diffs[i].moduleState).u16(uint16_t(j - i));
            for (size_t k = i; k < j; k++) w.u16(r.diffs[k].subslot).u32(r.diffs[k].submoduleIdent).u16(r.diffs[k].submoduleState);
        }
        w.endBlock(at);
    }
}

bool parseConnectResponse(const std::vector<Block>& blocks, ConnectResponse& out) {
    bool haveAr = false;
    for (const Block& b : blocks) {
        Reader r(b.data, b.length);
        if (b.type == BT_AR_RES) {
            out.arType = r.u16();
            out.arUuid = r.uuid();
            out.sessionKey = r.u16();
            out.responderMac = r.mac();
            out.responderUdpPort = r.u16();
            haveAr = r.ok();
        } else if (b.type == BT_IOCR_RES) {
            ConnectResponse::Cr cr;
            cr.type = r.u16();
            cr.reference = r.u16();
            cr.frameId = r.u16();
            if (r.ok()) out.iocrs.push_back(cr);
        } else if (b.type == BT_ALARMCR_RES) {
            out.alarmType = r.u16();
            out.alarmReference = r.u16();
            out.alarmMaxLength = r.u16();
        } else if (b.type == BT_MODULE_DIFF) {
            uint16_t apis = r.u16();
            for (uint16_t a = 0; a < apis && r.ok(); a++) {
                uint32_t api = r.u32();
                uint16_t modules = r.u16();
                for (uint16_t m = 0; m < modules && r.ok(); m++) {
                    ConnectResponse::Diff d{};
                    d.api = api;
                    d.slot = r.u16();
                    d.moduleIdent = r.u32();
                    d.moduleState = r.u16();
                    uint16_t subs = r.u16();
                    for (uint16_t s = 0; s < subs && r.ok(); s++) {
                        d.subslot = r.u16();
                        d.submoduleIdent = r.u32();
                        d.submoduleState = r.u16();
                        out.diffs.push_back(d);
                    }
                    if (!subs) out.diffs.push_back(d);
                }
            }
        }
    }
    return haveAr;
}

bool parseControl(const Block& b, ControlBlock& c) {
    Reader r(b.data, b.length);
    c.type = b.type;
    r.u16();
    c.arUuid = r.uuid();
    c.sessionKey = r.u16();
    r.u16();
    c.command = r.u16();
    c.properties = r.u16();
    return r.ok();
}

void writeControl(Writer& w, const ControlBlock& c) {
    size_t at = w.beginBlock(c.type);
    w.u16(0).uuid(c.arUuid).u16(c.sessionKey).u16(0).u16(c.command).u16(c.properties);
    w.endBlock(at);
}

bool parseRecordHeader(const Block& b, RecordHeader& h) {
    Reader r(b.data, b.length);
    h.type = b.type;
    h.sequence = r.u16();
    h.arUuid = r.uuid();
    h.api = r.u32();
    h.slot = r.u16();
    h.subslot = r.u16();
    r.u16();
    h.index = r.u16();
    h.length = r.u32();
    return r.ok();
}

void writeRecordReq(Writer& w, const RecordHeader& h) {
    size_t at = w.beginBlock(h.type);
    w.u16(h.sequence).uuid(h.arUuid).u32(h.api).u16(h.slot).u16(h.subslot).u16(0).u16(h.index).u32(h.length).zeros(24);
    w.endBlock(at);
}

void writeRecordRes(Writer& w, const RecordHeader& h, uint32_t status) {
    const bool read = h.type == BT_IOD_READ_REQ;
    size_t at = w.beginBlock(read ? BT_IOD_READ_RES : BT_IOD_WRITE_RES);
    w.u16(h.sequence).uuid(h.arUuid).u32(h.api).u16(h.slot).u16(h.subslot).u16(0).u16(h.index).u32(h.length);
    w.u16(0).u16(0);  // additional values
    if (read) {
        w.zeros(20);
    } else {
        w.u32(status).zeros(16);
    }
    w.endBlock(at);
}

bool parseRta(const uint8_t* p, size_t n, RtaHeader& h) {
    Reader r(p, n);
    h.dst = r.u16();
    h.src = r.u16();
    uint8_t pdu = r.u8();
    h.type = pdu & 0x0F;
    h.flags = r.u8();
    h.sendSeq = r.u16();
    h.ackSeq = r.u16();
    uint16_t len = r.u16();
    if (!r.ok() || len > r.remaining()) return false;
    h.sdu = r.here();
    h.length = len;
    return true;
}

void writeRtaFrame(std::vector<uint8_t>& out, const Mac& dst, const Mac& src, bool high, const RtaHeader& h, const uint8_t* sdu, size_t n) {
    out.clear();
    Writer w(out);
    writeEthPn(w, dst, src, high ? VLAN_ALARM_HIGH : VLAN_ALARM_LOW);
    w.u16(high ? FRAME_ALARM_HIGH : FRAME_ALARM_LOW).u16(h.dst).u16(h.src).u8(uint8_t(0x10 | h.type)).u8(h.flags);
    w.u16(h.sendSeq).u16(h.ackSeq).u16(uint16_t(n)).bytes(sdu, n);
    while (out.size() < 60) out.push_back(0);
}

bool parseAlarm(const uint8_t* p, size_t n, AlarmInfo& a) {
    std::vector<Block> blocks;
    if (!parseBlocks(p, n, blocks) || blocks.empty()) return false;
    const Block& b = blocks[0];
    Reader r(b.data, b.length);
    a.blockType = b.type;
    a.type = r.u16();
    a.api = r.u32();
    a.slot = r.u16();
    a.subslot = r.u16();
    if (b.type == BT_ALARM_ACK_HIGH || b.type == BT_ALARM_ACK_LOW) {
        a.specifier = r.u16();
        a.status = r.u32();
        return r.ok();
    }
    a.moduleIdent = r.u32();
    a.submoduleIdent = r.u32();
    a.specifier = r.u16();
    if (r.remaining() >= 2) {
        a.usi = r.u16();
        size_t left = r.remaining();
        const uint8_t* d = r.take(left);
        if (d) a.data.assign(d, d + left);
    }
    return r.ok();
}

void writeAlarmNotification(Writer& w, const AlarmInfo& a) {
    size_t at = w.beginBlock(a.blockType);
    w.u16(a.type).u32(a.api).u16(a.slot).u16(a.subslot).u32(a.moduleIdent).u32(a.submoduleIdent).u16(a.specifier);
    if (a.usi) w.u16(a.usi).bytes(a.data.data(), a.data.size());
    w.endBlock(at);
}

void writeAlarmAck(Writer& w, const AlarmInfo& a) {
    size_t at = w.beginBlock(a.blockType == BT_ALARM_HIGH ? BT_ALARM_ACK_HIGH : BT_ALARM_ACK_LOW);
    w.u16(a.type).u32(a.api).u16(a.slot).u16(a.subslot).u16(a.specifier).u32(a.status);
    w.endBlock(at);
}

std::vector<ChannelDiag> channelDiagnoses(const AlarmInfo& a) {
    std::vector<ChannelDiag> out;
    if (a.usi != USI_CHANNEL_DIAGNOSIS) return out;
    for (size_t i = 0; i + 6 <= a.data.size(); i += 6) {
        ChannelDiag c;
        c.channel = uint16_t((a.data[i] << 8) | a.data[i + 1]);
        c.properties = uint16_t((a.data[i + 2] << 8) | a.data[i + 3]);
        c.errorType = uint16_t((a.data[i + 4] << 8) | a.data[i + 5]);
        out.push_back(c);
    }
    return out;
}

const char* channelErrorText(uint16_t e) {
    switch (e) {
        case 0x0001: return "short circuit";
        case 0x0002: return "undervoltage";
        case 0x0003: return "overvoltage";
        case 0x0004: return "overload";
        case 0x0005: return "overtemperature";
        case 0x0006: return "wire break";
        case 0x0007: return "upper limit exceeded";
        case 0x0008: return "lower limit exceeded";
        case 0x0009: return "error";
        case 0x0010: return "parametrization fault";
        case 0x0011: return "power supply fault";
        case 0x0012: return "fuse blown";
        case 0x0014: return "ground fault";
        case 0x0015: return "reference point lost";
        case 0x0016: return "process event lost";
        case 0x0017: return "threshold warning";
        case 0x0018: return "output disabled";
        case 0x001A: return "external fault";
        default: return e >= 0x0100 && e <= 0x7FFF ? "manufacturer specific error" : "error";
    }
}

void writeRtFrame(std::vector<uint8_t>& out, const Mac& dst, const Mac& src, uint16_t vlan, uint16_t frameId, const uint8_t* csdu, size_t length,
                  uint16_t cycleCounter, uint8_t dataStatus) {
    out.clear();
    Writer w(out);
    writeEthPn(w, dst, src, vlan);
    w.u16(frameId).bytes(csdu, length);
    if (length < 40) w.zeros(40 - length);
    w.u16(cycleCounter).u8(dataStatus).u8(0);
}

}  // namespace pn
}  // namespace vplc
