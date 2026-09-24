#include "program.h"

#include <string.h>

#include "bytes.h"
#include "isa.h"

namespace vplc {

uint32_t Program::funcCode(uint16_t f) const { return rd32le(funcs.data + 2 + f * 12); }
uint32_t Program::funcFrame(uint16_t f) const { return rd32le(funcs.data + 2 + f * 12 + 4); }
uint32_t Program::funcFrameSize(uint16_t f) const { return rd32le(funcs.data + 2 + f * 12 + 8); }

uint16_t Program::lineAt(uint32_t pc, uint16_t* func) const {
    if (lines.size < 4) return 0;
    uint32_t n = rd32le(lines.data);
    uint16_t line = 0;
    for (uint32_t i = 0; i < n; i++) {
        const uint8_t* e = lines.data + 4 + i * 8;
        if (rd32le(e) > pc) break;
        if (func) *func = rd16le(e + 4);
        line = rd16le(e + 6);
    }
    return line;
}

static bool within(const Blob& b, uint32_t need) { return b.size >= need; }

const char* parseProgram(const uint8_t* image, size_t len, Program& out) {
    out = Program();
    if (len < 12 || memcmp(image, "VPLC", 4) != 0) return "not a VirtualPLC program";
    uint32_t crc = rd32le(image + len - 4);
    if (crc32(image, uint32_t(len - 4)) != crc) return "checksum mismatch";
    if (rd16le(image + 4) != ISA_VERSION) return "unsupported program format (update the firmware)";
    out.id = crc;

    uint16_t count = rd16le(image + 6);
    size_t pos = 8;
    bool haveLimits = false, haveCode = false, haveFuncs = false, haveEntries = false;
    for (uint16_t i = 0; i < count; i++) {
        if (pos + 5 > len - 4) return "truncated section header";
        uint8_t type = image[pos];
        uint32_t size = rd32le(image + pos + 1);
        if (size > len - 4 - pos - 5) return "truncated section";
        Blob b{image + pos + 5, size};
        switch (Section(type)) {
            case Section::SEC_META:
                if (size >= 1) {
                    uint8_t n = b.data[0] < 32 ? b.data[0] : 32;
                    if (1u + b.data[0] <= size) memcpy(out.name, b.data + 1, n);
                    uint32_t at = 1 + b.data[0];
                    if (at < size) at += 1 + b.data[at];
                    if (at + 4 <= size) out.buildTime = rd32le(b.data + at);
                }
                break;
            case Section::SEC_LIMITS:
                if (!within(b, 16)) return "invalid LIMITS section";
                out.dataSize = rd32le(b.data);
                out.iSize = rd16le(b.data + 4);
                out.qSize = rd16le(b.data + 6);
                out.mSize = rd16le(b.data + 8);
                out.stackCells = rd16le(b.data + 10);
                out.callDepth = rd16le(b.data + 12);
                out.cycleMs = size >= 16 ? rd16le(b.data + 14) : 10;
                haveLimits = true;
                break;
            case Section::SEC_CODE: out.code = b; haveCode = true; break;
            case Section::SEC_CONST: out.consts = b; break;
            case Section::SEC_INIT: out.init = b; break;
            case Section::SEC_FUNCS:
                if (!within(b, 2)) return "invalid FUNCS section";
                out.funcs = b;
                out.funcCount = rd16le(b.data);
                if (size < 2u + out.funcCount * 12u) return "invalid FUNCS section";
                haveFuncs = true;
                break;
            case Section::SEC_ENTRIES:
                if (!within(b, 4)) return "invalid ENTRIES section";
                out.startup = rd16le(b.data);
                out.main = rd16le(b.data + 2);
                haveEntries = true;
                break;
            case Section::SEC_LINES: out.lines = b; break;
            case Section::SEC_IOCONF: out.ioconf = b; break;
            case Section::SEC_SYMS: out.syms = b; break;
            case Section::SEC_DATALOGS: out.datalogs = b; break;
            case Section::SEC_DBS: out.dbs = b; break;
            case Section::SEC_SERVICES:
                if (size >= 6) {
                    out.services.opcuaPort = rd16le(b.data);
                    out.services.opcua = b.data[2] & 1;
                    out.services.opcuaWrite = b.data[2] & 2;
                    out.services.opcuaAnonymous = b.data[2] & 4;
                    out.services.s7Port = rd16le(b.data + 3);
                    out.services.s7 = b.data[5] & 1;
                    out.services.s7Write = b.data[5] & 2;
                }
                break;
            default: break;  // unknown sections are ignored (forward compatibility)
        }
        pos += 5 + size;
    }
    if (!haveLimits || !haveCode || !haveFuncs || !haveEntries) return "missing section";
    if (out.init.size > out.dataSize) return "INIT larger than data memory";
    if (out.cycleMs == 0) out.cycleMs = 1;
    for (uint16_t f = 0; f < out.funcCount; f++) {
        if (out.funcCode(f) >= out.code.size) return "function outside of code";
        if (uint64_t(out.funcFrame(f)) + out.funcFrameSize(f) > out.dataSize) return "function frame outside of data";
    }
    if (out.startup != 0xFFFF && out.startup >= out.funcCount) return "invalid startup entry";
    if (out.main != 0xFFFF && out.main >= out.funcCount) return "invalid main entry";
    return nullptr;
}

IoModuleReader::IoModuleReader(const Blob& ioconf) : p_(ioconf.data), end_(ioconf.data + ioconf.size) {
    if (ioconf.size >= 2) {
        count_ = rd16le(p_);
        p_ += 2;
    } else {
        p_ = end_;
    }
}

bool IoModuleReader::next(IoModuleInfo& m) {
    if (read_ >= count_ || p_ >= end_) return false;
    m = IoModuleInfo();
    m.kind = *p_++;
    auto need = [&](size_t n) { return size_t(end_ - p_) >= n; };
    switch (IoModule(m.kind)) {
        case IoModule::IO_MODBUS_TCP: {
            if (!need(1)) return false;
            uint8_t n = *p_++;
            if (!need(n + 2 + 1 + 16 + 2)) return false;
            uint8_t copy = n < sizeof(m.host) - 1 ? n : uint8_t(sizeof(m.host) - 1);
            memcpy(m.host, p_, copy);
            p_ += n;
            m.port = rd16le(p_); p_ += 2;
            m.unit = *p_++;
            m.diCount = rd16le(p_); m.diByte = rd16le(p_ + 2);
            m.coilCount = rd16le(p_ + 4); m.coilByte = rd16le(p_ + 6);
            m.irCount = rd16le(p_ + 8); m.irByte = rd16le(p_ + 10);
            m.hrCount = rd16le(p_ + 12); m.hrByte = rd16le(p_ + 14);
            m.pollMs = rd16le(p_ + 16);
            p_ += 18;
            break;
        }
        case IoModule::IO_GPIO_DI:
        case IoModule::IO_GPIO_DO:
            if (!need(5)) return false;
            m.pin = p_[0]; m.byte = rd16le(p_ + 1); m.bit = p_[3]; m.flags = p_[4];
            p_ += 5;
            break;
        case IoModule::IO_GPIO_AI:
        case IoModule::IO_GPIO_AO:
            if (!need(3)) return false;
            m.pin = p_[0]; m.byte = rd16le(p_ + 1);
            p_ += 3;
            break;
        case IoModule::IO_IOLINK_MASTER: {
            if (!need(1)) return false;
            uint8_t n = *p_++;
            if (!need(n + 2 + 1 + 2 + 1 + 1)) return false;
            uint8_t copy = n < sizeof(m.host) - 1 ? n : uint8_t(sizeof(m.host) - 1);
            memcpy(m.host, p_, copy);
            p_ += n;
            m.port = rd16le(p_);
            m.unit = p_[2];
            m.pollMs = rd16le(p_ + 3);
            m.inFunction = p_[5];
            uint8_t count = p_[6];
            p_ += 7;
            if (!need(size_t(count) * 11)) return false;
            m.portCount = count < 16 ? count : 16;
            for (uint8_t i = 0; i < count; i++, p_ += 11) {
                if (i >= 16) continue;
                IoModuleInfo::IoLinkPort& q = m.ports[i];
                q.port = p_[0];
                q.inRegister = rd16le(p_ + 1);
                q.inByte = rd16le(p_ + 3);
                q.inLength = p_[5];
                q.outRegister = rd16le(p_ + 6);
                q.outByte = rd16le(p_ + 8);
                q.outLength = p_[10];
            }
            break;
        }
        case IoModule::IO_PROFINET_DEVICE:
        case IoModule::IO_PROFINET_REMOTE: {
            auto str = [&](char* dst, size_t cap) {
                if (!need(1)) return false;
                uint8_t n = *p_++;
                if (!need(n)) return false;
                size_t copy = n < cap - 1 ? n : cap - 1;
                memcpy(dst, p_, copy);
                dst[copy] = 0;
                p_ += n;
                return true;
            };
            if (!str(m.ifname, sizeof(m.ifname)) || !str(m.station, sizeof(m.station))) return false;
            if (IoModule(m.kind) == IoModule::IO_PROFINET_DEVICE) {
                if (!need(12)) return false;
                m.vendorId = rd16le(p_); m.deviceId = rd16le(p_ + 2);
                m.inByte = rd16le(p_ + 4); m.inLength = rd16le(p_ + 6);
                m.outByte = rd16le(p_ + 8); m.outLength = rd16le(p_ + 10);
                p_ += 12;
                break;
            }
            if (!str(m.host, sizeof(m.host)) || !need(9)) return false;
            m.vendorId = rd16le(p_); m.deviceId = rd16le(p_ + 2);
            m.cycleMs = rd16le(p_ + 4); m.watchdog = rd16le(p_ + 6);
            uint8_t count = p_[8];
            p_ += 9;
            m.subCount = size_t(count) + 1 <= size_t(VPLC_PN_MAX_SUBMODULES) ? count : uint8_t(VPLC_PN_MAX_SUBMODULES);
            for (uint8_t i = 0; i < count; i++) {
                if (!need(21)) return false;
                IoModuleInfo::PnSub tmp;
                IoModuleInfo::PnSub& x = size_t(i) + 1 <= size_t(VPLC_PN_MAX_SUBMODULES) ? m.subs[i] : tmp;
                x.slot = rd16le(p_); x.subslot = rd16le(p_ + 2);
                x.moduleIdent = rd32le(p_ + 4); x.submoduleIdent = rd32le(p_ + 8);
                x.inLength = rd16le(p_ + 12); x.inByte = rd16le(p_ + 14);
                x.outLength = rd16le(p_ + 16); x.outByte = rd16le(p_ + 18);
                uint8_t records = p_[20];
                p_ += 21;
                x.recordOffset = m.recordUsed;
                for (uint8_t r = 0; r < records; r++) {
                    if (!need(4)) return false;
                    uint16_t len = rd16le(p_ + 2);
                    if (!need(4u + len)) return false;
                    if (size_t(i) + 1 <= size_t(VPLC_PN_MAX_SUBMODULES) && size_t(m.recordUsed) + 4 + len <= size_t(VPLC_PN_RECORD_POOL)) {
                        uint8_t* d = m.recordPool + m.recordUsed;
                        d[0] = p_[0]; d[1] = p_[1]; d[2] = p_[2]; d[3] = p_[3];  // index, length (little endian)
                        memcpy(d + 4, p_ + 4, len);
                        m.recordUsed = uint16_t(m.recordUsed + 4 + len);
                        x.recordCount++;
                    }
                    p_ += 4 + len;
                }
            }
            break;
        }
        default:
            return false;
    }
    read_++;
    return true;
}

// ---------------------------------------------------------------------------
// Data logs
// ---------------------------------------------------------------------------

namespace {
// Copies a u8-length string; false when the data is truncated
bool str8(const uint8_t*& p, const uint8_t* end, char* out, size_t cap) {
    if (p >= end) return false;
    uint8_t n = *p++;
    if (size_t(end - p) < n) return false;
    size_t copy = n < cap - 1 ? n : cap - 1;
    memcpy(out, p, copy);
    out[copy] = 0;
    p += n;
    return true;
}
}  // namespace

DataLogReader::DataLogReader(const Blob& section) : p_(section.data), end_(section.data + section.size) {
    if (section.size >= 2) {
        count_ = rd16le(p_);
        p_ += 2;
    } else {
        p_ = end_;
    }
}

bool DataLogReader::next(DataLogInfo& log) {
    if (read_ >= count_ || p_ >= end_) return false;
    log = DataLogInfo();
    auto need = [&](size_t n) { return size_t(end_ - p_) >= n; };
    if (!str8(p_, end_, log.name, sizeof log.name) || !need(1)) return false;
    log.trigger = *p_++;
    if (log.trigger == DataLogInfo::EDGE) {
        if (!need(6)) return false;
        log.edgeArea = p_[0];
        log.edgeOffset = rd32le(p_ + 1);
        log.edgeBit = p_[5];
        p_ += 6;
    } else if (log.trigger == DataLogInfo::PERIOD) {
        if (!need(4)) return false;
        log.periodMs = rd32le(p_);
        p_ += 4;
    }
    if (!need(3)) return false;
    log.retentionDays = rd16le(p_);
    log.columnCount = p_[2];
    p_ += 3;
    log.columns = p_;
    for (uint8_t k = 0; k < log.columnCount; k++) {
        if (!need(1)) return false;
        uint8_t n = *p_;
        if (!need(1 + size_t(n) + 9)) return false;
        p_ += 1 + n + 9;
    }
    log.columnsEnd = p_;
    if (!need(1)) return false;
    log.dbKind = *p_++;
    if (log.dbKind != DataLogInfo::NONE) {
        if (!str8(p_, end_, log.host, sizeof log.host) || !need(2)) return false;
        log.port = rd16le(p_);
        p_ += 2;
        if (!str8(p_, end_, log.database, sizeof log.database) || !str8(p_, end_, log.table, sizeof log.table)
            || !str8(p_, end_, log.user, sizeof log.user) || !need(1)) {
            return false;
        }
        log.tls = *p_++;
    }
    read_++;
    return true;
}

bool DataLogInfo::column(uint8_t& pos, const uint8_t*& cursor, DataLogColumn& out) const {
    if (pos == 0) cursor = columns;
    if (pos >= columnCount || !cursor || cursor >= columnsEnd) return false;
    out = DataLogColumn();
    if (!str8(cursor, columnsEnd, out.name, sizeof out.name) || size_t(columnsEnd - cursor) < 9) return false;
    out.area = cursor[0];
    out.offset = rd32le(cursor + 1);
    out.bit = cursor[5];
    out.type = cursor[6];
    out.size = rd16le(cursor + 7);
    cursor += 9;
    pos++;
    return true;
}

uint32_t DataLogInfo::recordSize() const {
    uint32_t total = 0;
    uint8_t pos = 0;
    const uint8_t* cursor = nullptr;
    DataLogColumn c;
    while (column(pos, cursor, c)) total += c.bit != 0xFF ? 1 : c.size;
    return total;
}

}  // namespace vplc
