#include "hmi.h"

#include <string.h>

#include "bytes.h"
#include "isa.h"

namespace vplc {

namespace {
constexpr uint8_t T_BOOL = uint8_t(VmType::T_BOOL), T_U8 = uint8_t(VmType::T_U8), T_I8 = uint8_t(VmType::T_I8),
                  T_U16 = uint8_t(VmType::T_U16), T_I16 = uint8_t(VmType::T_I16), T_U32 = uint8_t(VmType::T_U32),
                  T_I32 = uint8_t(VmType::T_I32), T_I64 = uint8_t(VmType::T_I64), T_F32 = uint8_t(VmType::T_F32),
                  T_F64 = uint8_t(VmType::T_F64);
}  // namespace

bool SymbolInfo::segment(uint8_t i, const char*& text, uint8_t& length) const {
    if (i >= segments) return false;
    const uint8_t* p = path;
    for (uint8_t k = 0; k < i; k++) p += 1 + p[0];
    length = p[0];
    text = reinterpret_cast<const char*>(p + 1);
    return true;
}

size_t SymbolInfo::fullPath(char* out, size_t cap, char sep) const {
    size_t n = 0;
    for (uint8_t i = 0; i < segments; i++) {
        const char* t;
        uint8_t len;
        segment(i, t, len);
        if (i && n + 1 < cap) out[n++] = sep;
        for (uint8_t k = 0; k < len && n + 1 < cap; k++) out[n++] = t[k];
    }
    if (cap) out[n] = 0;
    return n;
}

SymbolReader::SymbolReader(const Blob& syms) : p_(syms.data), end_(syms.data + syms.size) {
    if (syms.size >= 4) {
        count_ = rd32le(p_);
        p_ += 4;
    } else {
        p_ = end_;
    }
}

bool SymbolReader::next(SymbolInfo& s) {
    if (read_ >= count_ || size_t(end_ - p_) < 11) return false;
    s = SymbolInfo();
    s.area = p_[0];
    s.offset = rd32le(p_ + 1);
    s.bit = p_[5];
    s.type = p_[6];
    s.size = rd16le(p_ + 7);
    s.writable = p_[9] & 1;
    s.segments = p_[10];
    const uint8_t* q = p_ + 11;
    for (uint8_t i = 0; i < s.segments; i++) {
        if (q >= end_ || size_t(end_ - q) < 1u + q[0]) return false;
        q += 1 + q[0];
    }
    s.path = p_ + 11;
    s.index = read_++;
    p_ = q;
    return true;
}

bool findDb(const Blob& dbs, uint16_t number, DbInfo& out) {
    if (dbs.size < 2) return false;
    uint16_t n = rd16le(dbs.data);
    const uint8_t* p = dbs.data + 2;
    const uint8_t* end = dbs.data + dbs.size;
    for (uint16_t i = 0; i < n; i++) {
        if (size_t(end - p) < 11 || size_t(end - p) < 11u + p[10]) return false;
        if (rd16le(p) == number) {
            out.number = number;
            out.offset = rd32le(p + 2);
            out.size = rd32le(p + 6);
            return true;
        }
        p += 11 + p[10];
    }
    return false;
}

static uint8_t* locate(Vm& vm, const SymbolInfo& sym) {
    uint32_t size = 0;
    uint8_t* base = vm.area(sym.area, size);
    if (!base || uint64_t(sym.offset) + (sym.bit != 0xFF ? 1 : sym.size) > size) return nullptr;
    return base + sym.offset;
}

bool hmiRead(Vm& vm, const SymbolInfo& sym, HmiValue& out) {
    uint8_t* p = locate(vm, sym);
    if (!p) return false;
    out = HmiValue();
    if (sym.bit != 0xFF) {
        out.kind = HmiValue::BOOL;
        out.b = (p[0] >> sym.bit) & 1;
        return true;
    }
    switch (sym.type) {
        case T_BOOL: out.kind = HmiValue::BOOL; out.b = p[0] != 0; return true;
        case T_U8: out.kind = HmiValue::UINT; out.u = p[0]; return true;
        case T_I8: out.kind = HmiValue::INT; out.i = int8_t(p[0]); return true;
        case T_U16: out.kind = HmiValue::UINT; out.u = rdbe(p, 2); return true;
        case T_I16: out.kind = HmiValue::INT; out.i = int16_t(uint16_t(rdbe(p, 2))); return true;
        case T_U32: out.kind = HmiValue::UINT; out.u = rdbe(p, 4); return true;
        case T_I32:
        case HMI_TIME: out.kind = HmiValue::INT; out.i = int32_t(uint32_t(rdbe(p, 4))); return true;
        case T_I64: out.kind = HmiValue::INT; out.i = int64_t(rdbe(p, 8)); return true;
        case T_F32: {
            uint32_t bits = uint32_t(rdbe(p, 4));
            float f;
            memcpy(&f, &bits, 4);
            out.kind = HmiValue::REAL;
            out.f = f;
            return true;
        }
        case T_F64: {
            uint64_t bits = rdbe(p, 8);
            double d;
            memcpy(&d, &bits, 8);
            out.kind = HmiValue::REAL;
            out.f = d;
            return true;
        }
        case HMI_STRING: {
            uint8_t len = p[1] < p[0] ? p[1] : p[0];
            if (uint32_t(len) + 2 > sym.size) len = uint8_t(sym.size - 2);
            out.kind = HmiValue::STRING;
            memcpy(out.s, p + 2, len);
            out.s[len] = 0;
            out.length = len;
            return true;
        }
        default: return false;
    }
}

static bool asNumber(const HmiValue& v, double& f, int64_t& i, bool& isInt) {
    switch (v.kind) {
        case HmiValue::BOOL: i = v.b; f = v.b; isInt = true; return true;
        case HmiValue::INT: i = v.i; f = double(v.i); isInt = true; return true;
        case HmiValue::UINT: i = int64_t(v.u); f = double(v.u); isInt = true; return true;
        case HmiValue::REAL: f = v.f; i = int64_t(v.f); isInt = false; return true;
        default: return false;
    }
}

const char* hmiWrite(Vm& vm, const SymbolInfo& sym, const HmiValue& v) {
    if (!sym.writable) return "read-only";
    uint8_t* p = locate(vm, sym);
    if (!p) return "not available";
    if (sym.type == HMI_STRING) {
        if (v.kind != HmiValue::STRING) return "type mismatch";
        uint8_t max = p[0] ? p[0] : uint8_t(sym.size - 2);
        uint8_t len = v.length < max ? v.length : max;
        memcpy(p + 2, v.s, len);
        p[1] = len;
        return nullptr;
    }
    double f;
    int64_t i;
    bool isInt;
    if (!asNumber(v, f, i, isInt)) return "type mismatch";
    if (sym.bit != 0xFF || sym.type == T_BOOL) {
        bool b = isInt ? i != 0 : f != 0;
        if (sym.bit != 0xFF) p[0] = uint8_t(b ? p[0] | (1u << sym.bit) : p[0] & ~(1u << sym.bit));
        else p[0] = b;
        return nullptr;
    }
    auto range = [&](double lo, double hi) { return (isInt ? double(i) : f) >= lo && (isInt ? double(i) : f) <= hi; };
    switch (sym.type) {
        case T_U8: if (!range(0, 255)) return "out of range"; p[0] = uint8_t(isInt ? i : int64_t(f)); return nullptr;
        case T_I8: if (!range(-128, 127)) return "out of range"; p[0] = uint8_t(int8_t(isInt ? i : int64_t(f))); return nullptr;
        case T_U16: if (!range(0, 65535)) return "out of range"; wrbe(p, 2, uint64_t(isInt ? i : int64_t(f))); return nullptr;
        case T_I16: if (!range(-32768, 32767)) return "out of range"; wrbe(p, 2, uint16_t(int16_t(isInt ? i : int64_t(f)))); return nullptr;
        case T_U32: if (!range(0, 4294967295.0)) return "out of range"; wrbe(p, 4, uint64_t(isInt ? i : int64_t(f))); return nullptr;
        case T_I32:
        case HMI_TIME:
            if (!range(-2147483648.0, 2147483647.0)) return "out of range";
            wrbe(p, 4, uint32_t(int32_t(isInt ? i : int64_t(f))));
            return nullptr;
        case T_I64: wrbe(p, 8, uint64_t(isInt ? i : int64_t(f))); return nullptr;
        case T_F32: {
            float x = float(f);
            uint32_t bits;
            memcpy(&bits, &x, 4);
            wrbe(p, 4, bits);
            return nullptr;
        }
        case T_F64: {
            uint64_t bits;
            memcpy(&bits, &f, 8);
            wrbe(p, 8, bits);
            return nullptr;
        }
        default: return "unsupported type";
    }
}

bool hmiRangeReadOnly(const Blob& syms, uint8_t area, uint32_t offset, uint32_t size) {
    SymbolReader r(syms);
    SymbolInfo s;
    while (r.next(s)) {
        if (s.area != area || s.writable) continue;
        uint32_t end = s.offset + (s.bit != 0xFF ? 1 : s.size);
        if (s.offset < offset + size && offset < end) return true;
    }
    return false;
}

}  // namespace vplc
