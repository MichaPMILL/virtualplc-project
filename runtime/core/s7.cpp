#include "s7.h"

#include <string.h>

#include "bytes.h"
#include "hmi.h"
#include "isa.h"

namespace vplc {

namespace {

constexpr uint16_t MAX_PDU = 480;

inline uint16_t be16(const uint8_t* p) { return uint16_t(p[0] << 8 | p[1]); }
inline void put16(uint8_t* p, uint16_t v) { p[0] = uint8_t(v >> 8); p[1] = uint8_t(v); }

// Return codes of data items
enum : uint8_t { RC_OK = 0xFF, RC_ACCESS = 0x03, RC_RANGE = 0x05, RC_TYPE = 0x06, RC_OBJECT = 0x0A };

// Size in bytes of one element of a request transport size
unsigned elementSize(uint8_t ts) {
    switch (ts) {
        case 0x01: case 0x02: case 0x03: return 1;  // BIT, BYTE, CHAR
        case 0x04: case 0x05: return 2;             // WORD, INT
        case 0x06: case 0x07: case 0x08: return 4;  // DWORD, DINT, REAL
        default: return 0;
    }
}

struct Target {
    uint8_t* base = nullptr;  // start of the addressed memory
    uint32_t size = 0;        // bytes available from base
    uint8_t area = 0;         // VM area (for access rights)
    uint32_t areaOffset = 0;  // offset of base in the VM area
};

// Resolves an S7 area / DB number to PLC memory.
uint8_t resolve(Vm& vm, const Program& program, uint8_t area, uint16_t db, Target& t) {
    uint32_t size = 0;
    switch (area) {
        case S7_AREA_I: t.base = vm.area(uint8_t(Area::I), size); t.area = uint8_t(Area::I); break;
        case S7_AREA_Q: t.base = vm.area(uint8_t(Area::Q), size); t.area = uint8_t(Area::Q); break;
        case S7_AREA_M: t.base = vm.area(uint8_t(Area::M), size); t.area = uint8_t(Area::M); break;
        case S7_AREA_DB: {
            DbInfo info;
            if (!findDb(program.dbs, db, info)) return RC_OBJECT;
            uint8_t* d = vm.area(uint8_t(Area::D), size);
            if (!d || uint64_t(info.offset) + info.size > size) return RC_OBJECT;
            t.base = d + info.offset;
            t.size = info.size;
            t.area = uint8_t(Area::D);
            t.areaOffset = info.offset;
            return RC_OK;
        }
        default: return RC_OBJECT;
    }
    if (!t.base) return RC_OBJECT;
    t.size = size;
    return RC_OK;
}

}  // namespace

bool S7Session::receive(const uint8_t* data, size_t length, Vm& vm, const Program& program, const Options& options, SendFn send, void* ctx) {
    while (length > 0) {
        size_t take = sizeof in_ - used_ < length ? sizeof in_ - used_ : length;
        memcpy(in_ + used_, data, take);
        used_ += take;
        data += take;
        length -= take;
        for (;;) {
            if (used_ < 4) break;
            if (in_[0] != 3) return false;  // not a TPKT
            uint16_t n = be16(in_ + 2);
            if (n < 7 || n > sizeof in_) return false;
            if (used_ < n) break;
            if (!packet(in_, n, vm, program, options, send, ctx)) return false;
            memmove(in_, in_ + n, used_ - n);
            used_ -= n;
        }
        if (used_ == sizeof in_) return false;
    }
    return true;
}

bool S7Session::packet(const uint8_t* p, size_t n, Vm& vm, const Program& program, const Options& options, SendFn send, void* ctx) {
    uint8_t li = p[4];
    if (size_t(5) + li > n) return false;
    uint8_t type = p[5];
    if (type == 0xE0) {  // COTP connection request -> connection confirm
        uint8_t out[64];
        size_t k = 4;
        out[k++] = 0;  // length indicator, set below
        out[k++] = 0xD0;
        out[k++] = p[8];  // destination reference = source reference of the request
        out[k++] = p[9];
        out[k++] = 0x00;
        out[k++] = 0x01;
        out[k++] = 0x00;  // class 0
        // echo the parameters (TPDU size, calling / called TSAP)
        for (size_t q = 11; q + 2 <= size_t(5) + li && k + 2 + p[q + 1] < sizeof out;) {
            uint8_t code = p[q], len = p[q + 1];
            if (q + 2 + len > size_t(5) + li) break;
            out[k++] = code;
            out[k++] = len;
            memcpy(out + k, p + q + 2, len);
            k += len;
            q += 2 + len;
        }
        out[4] = uint8_t(k - 5);
        out[0] = 3;
        out[1] = 0;
        put16(out + 2, uint16_t(k));
        connected_ = true;
        return send(ctx, out, k);
    }
    if (type == 0x80) return false;  // disconnect request
    if (type != 0xF0 || !connected_) return false;
    const uint8_t* s7 = p + 5 + li;
    size_t s7n = n - 5 - li;
    if (s7n < 10 || s7[0] != 0x32) return false;
    uint8_t out[MAX_PDU + 64];
    size_t len = job(s7, s7n, vm, program, options, out + 7, sizeof out - 7);
    if (!len) return true;  // ignored
    out[0] = 3;
    out[1] = 0;
    put16(out + 2, uint16_t(len + 7));
    out[4] = 2;
    out[5] = 0xF0;
    out[6] = 0x80;
    return send(ctx, out, len + 7);
}

size_t S7Session::job(const uint8_t* s7, size_t n, Vm& vm, const Program& program, const Options& options, uint8_t* out, size_t cap) {
    uint8_t rosctr = s7[1];
    uint16_t ref = be16(s7 + 4);
    uint16_t plen = be16(s7 + 6);
    uint16_t dlen = be16(s7 + 8);
    size_t hdr = rosctr == 2 || rosctr == 3 ? 12 : 10;
    if (hdr + plen + dlen > n) return 0;
    const uint8_t* param = s7 + hdr;
    const uint8_t* data = param + plen;

    // response header (ack_data): 0x32 03 0000 ref plen dlen errclass errcode
    auto header = [&](uint8_t rtype, uint16_t rp, uint16_t rd, uint8_t eclass, uint8_t ecode) {
        out[0] = 0x32;
        out[1] = rtype;
        out[2] = out[3] = 0;
        put16(out + 4, ref);
        put16(out + 6, rp);
        put16(out + 8, rd);
        if (rtype == 3) {
            out[10] = eclass;
            out[11] = ecode;
            return size_t(12);
        }
        return size_t(10);
    };

    if (rosctr == 7) {
        // User data (SZL, clock, ...): answer "object does not exist"
        if (plen < 8 || cap < 32) return 0;
        size_t h = header(7, 12, 4, 0, 0);
        uint8_t* q = out + h;
        memcpy(q, param, 4);             // 00 01 12 len
        q[3] = 8;
        q[4] = 0x12;                     // response method
        q[5] = uint8_t((param[5] & 0x0F) | 0x80);  // type response + function group
        q[6] = param[6];                 // subfunction
        q[7] = param[7];                 // sequence
        q[8] = 0;                        // data unit reference
        q[9] = 0;                        // last data unit
        q[10] = 0xD6;                    // error: object does not exist
        q[11] = 0x02;
        uint8_t* d = q + 12;
        d[0] = RC_OBJECT;
        d[1] = 0;
        d[2] = d[3] = 0;
        return h + 12 + 4;
    }
    if (rosctr != 1 || plen < 1) return 0;

    uint8_t fn = param[0];
    if (fn == 0xF0) {  // setup communication
        if (plen < 8) return 0;
        uint16_t req = be16(param + 6);
        pdu_ = req < 240 ? 240 : req > MAX_PDU ? MAX_PDU : req;
        size_t h = header(3, 8, 0, 0, 0);
        memcpy(out + h, param, 8);
        put16(out + h + 2, 1);
        put16(out + h + 4, 1);
        put16(out + h + 6, pdu_);
        return h + 8;
    }
    if ((fn != 0x04 && fn != 0x05) || plen < 2) {
        return header(3, 0, 0, 0x81, 0x04);  // function not supported
    }
    uint8_t count = param[1];
    if (plen < 2u + count * 12u || count > 20) return header(3, 0, 0, 0x85, 0x00);

    size_t h = header(3, 2, 0, 0, 0);
    out[h] = fn;
    out[h + 1] = count;
    uint8_t* d = out + h + 2;
    const size_t limit = pdu_ < cap ? pdu_ : cap;
    size_t used = h + 2;
    const uint8_t* wd = data;  // write data items
    const uint8_t* wend = data + dlen;

    for (uint8_t i = 0; i < count; i++) {
        const uint8_t* it = param + 2 + i * 12;
        uint8_t ts = it[3];
        uint16_t num = be16(it + 4);
        uint16_t db = be16(it + 6);
        uint8_t area = it[8];
        uint32_t addr = uint32_t(it[9]) << 16 | uint32_t(it[10]) << 8 | it[11];
        uint32_t byte = addr >> 3;
        uint8_t bit = addr & 7;
        unsigned es = elementSize(ts);
        uint32_t bytes = ts == 0x01 ? 1 : es * num;
        uint8_t rc = RC_OK;
        Target t;
        if (it[0] != 0x12 || !es || (ts == 0x01 && num != 1)) rc = RC_TYPE;
        else rc = resolve(vm, program, area, db, t);
        if (rc == RC_OK && uint64_t(byte) + bytes > t.size) rc = RC_RANGE;

        if (fn == 0x04) {  // read
            bool last = i + 1 == count;
            size_t need = 4 + bytes + ((bytes & 1) && !last ? 1 : 0);
            if (rc == RC_OK && used + need > limit) rc = RC_RANGE;  // does not fit in the PDU
            if (used + 4 > limit) break;
            d[0] = rc;
            if (rc != RC_OK) {
                d[1] = 0;
                d[2] = d[3] = 0;
                d += 4;
                used += 4;
                continue;
            }
            if (ts == 0x01) {
                d[1] = 0x03;
                put16(d + 2, 1);
                d[4] = (t.base[byte] >> bit) & 1;
            } else {
                d[1] = ts == 0x08 ? 0x07 : 0x04;
                put16(d + 2, uint16_t(ts == 0x08 ? bytes : bytes * 8));
                memcpy(d + 4, t.base + byte, bytes);
            }
            d += 4 + bytes;
            used += 4 + bytes;
            if ((bytes & 1) && !last) {
                *d++ = 0;
                used++;
            }
        } else {  // write
            if (wd + 4 > wend) return header(3, 0, 0, 0x85, 0x00);
            uint8_t wts = wd[1];
            uint16_t wlen = be16(wd + 2);
            uint32_t wbytes = wts == 0x03 || wts == 0x04 ? (wlen + 7) / 8 : wlen;
            const uint8_t* value = wd + 4;
            if (value + wbytes > wend) return header(3, 0, 0, 0x85, 0x00);
            if (rc == RC_OK && wbytes != bytes) rc = RC_TYPE;
            if (rc == RC_OK && (!options.allowWrite || t.area == uint8_t(Area::I) ||
                                hmiRangeReadOnly(program.syms, t.area, t.areaOffset + byte, bytes))) {
                rc = RC_ACCESS;
            }
            if (rc == RC_OK) {
                if (ts == 0x01) {
                    uint8_t mask = uint8_t(1u << bit);
                    t.base[byte] = uint8_t(value[0] & 1 ? t.base[byte] | mask : t.base[byte] & ~mask);
                } else {
                    memcpy(t.base + byte, value, bytes);
                }
            }
            wd = value + wbytes + ((wbytes & 1) && i + 1 < count ? 1 : 0);
            *d++ = rc;
            used++;
        }
    }
    put16(out + 8, uint16_t(d - (out + h + 2)));
    return size_t(d - out);
}

}  // namespace vplc
