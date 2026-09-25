#include "vm.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bytes.h"
#include "isa.h"

namespace vplc {

namespace {

constexpr uint8_t T_BOOL = uint8_t(VmType::T_BOOL), T_U8 = uint8_t(VmType::T_U8), T_I8 = uint8_t(VmType::T_I8),
                  T_U16 = uint8_t(VmType::T_U16), T_I16 = uint8_t(VmType::T_I16), T_U32 = uint8_t(VmType::T_U32),
                  T_I32 = uint8_t(VmType::T_I32), T_I64 = uint8_t(VmType::T_I64), T_F32 = uint8_t(VmType::T_F32),
                  T_F64 = uint8_t(VmType::T_F64), T_PTR = uint8_t(VmType::T_PTR), T_U64 = uint8_t(VmType::T_U64);

inline int64_t wrapTo(uint8_t type, int64_t v) {
    switch (type) {
        case T_BOOL: return v != 0;
        case T_U8: return uint8_t(v);
        case T_I8: return int8_t(uint8_t(v));
        case T_U16: return uint16_t(v);
        case T_I16: return int16_t(uint16_t(v));
        case T_U32: return uint32_t(v);
        case T_I32: return int32_t(uint32_t(v));
        default: return v;
    }
}

// Round half to even (IEC REAL_TO_INT), without relying on the FPU rounding mode.
inline double roundEven(double x) {
    double r = floor(x + 0.5);
    if (r - x == 0.5 && fmod(r, 2.0) != 0.0) r -= 1.0;
    return r;
}

// ---- calendar (proleptic Gregorian, days since 1970-01-01)
inline int64_t daysFromCivil(int64_t y, unsigned m, unsigned d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = unsigned(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + int64_t(doe) - 719468;
}
inline void civilFromDays(int64_t z, int64_t& y, unsigned& m, unsigned& d) {
    z += 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const unsigned doe = unsigned(z - era * 146097);
    const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    y = int64_t(yoe) + era * 400;
    const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const unsigned mp = (5 * doy + 2) / 153;
    d = doy - (153 * mp + 2) / 5 + 1;
    m = mp < 10 ? mp + 3 : mp - 9;
    y += m <= 2;
}
constexpr int64_t NS_PER_DAY = 86400000000000LL;
struct Civil { int64_t year; unsigned month, day, weekday, hour, minute, second; uint32_t ns; };
inline Civil splitLdt(int64_t ns) {
    int64_t days = ns >= 0 ? ns / NS_PER_DAY : -((-ns + NS_PER_DAY - 1) / NS_PER_DAY);
    int64_t rest = ns - days * NS_PER_DAY;
    Civil c;
    civilFromDays(days, c.year, c.month, c.day);
    c.weekday = unsigned(((days % 7) + 7 + 4) % 7) + 1;  // 1970-01-01 was a Thursday; 1 = Sunday
    c.hour = unsigned(rest / 3600000000000LL);
    c.minute = unsigned(rest / 60000000000LL % 60);
    c.second = unsigned(rest / 1000000000LL % 60);
    c.ns = uint32_t(rest % 1000000000LL);
    return c;
}
inline int64_t joinLdt(int64_t y, unsigned mo, unsigned d, unsigned h, unsigned mi, unsigned s, uint32_t ns) {
    return daysFromCivil(y, mo, d) * NS_PER_DAY + int64_t(h) * 3600000000000LL + int64_t(mi) * 60000000000LL + int64_t(s) * 1000000000LL + ns;
}
inline uint8_t bcd(unsigned v) { return uint8_t((v / 10 % 10) << 4 | v % 10); }
inline unsigned unbcd(uint8_t b) { return (b >> 4) * 10u + (b & 15u); }

inline int64_t toInt(double x) {
    if (x != x) return 0;
    if (x >= 9.2e18) return INT64_MAX;
    if (x <= -9.2e18) return INT64_MIN;
    return int64_t(x);
}

inline Area areaOf(int64_t ptr) { return Area(uint8_t(uint64_t(ptr) >> 32)); }
inline uint32_t offsetOf(int64_t ptr) { return uint32_t(uint64_t(ptr)); }
inline int64_t makePtr(uint8_t area, uint32_t offset) { return int64_t((uint64_t(area) << 32) | offset); }

}  // namespace

size_t Vm::arenaSize(const Program& p) {
    return size_t(p.dataSize) + p.iSize + p.qSize + p.mSize;
}

bool Vm::load(const Program* program, uint8_t* arena, size_t size, VmHost* host) {
    unload();
    if (!program || !arena || size < arenaSize(*program)) return false;
    program_ = program;
    host_ = host;
    d_ = arena;
    i_ = d_ + program->dataSize;
    q_ = i_ + program->iSize;
    m_ = q_ + program->qSize;
    reset();
    return true;
}

void Vm::unload() {
    program_ = nullptr;
    sp_ = depth_ = 0;
    waitingUntil_ = 0;
    suspended_ = false;
    fault_ = Fault();
}

void Vm::reset() {
    if (!program_) return;
    memset(d_, 0, arenaSize(*program_));
    if (program_->init.size) memcpy(d_, program_->init.data, program_->init.size);
    sp_ = depth_ = 0;
    waitingUntil_ = 0;
    suspended_ = false;
    fault_ = Fault();
}

uint8_t* Vm::area(uint8_t a, uint32_t& size) {
    if (!program_) { size = 0; return nullptr; }
    switch (Area(a)) {
        case Area::D: size = program_->dataSize; return d_;
        case Area::I: size = program_->iSize; return i_;
        case Area::Q: size = program_->qSize; return q_;
        case Area::M: size = program_->mSize; return m_;
        default: size = 0; return nullptr;
    }
}

Vm::Result Vm::startup(uint32_t now) {
    if (!program_ || program_->startup == 0xFFFF) return DONE;
    return run(program_->startup, now);
}

Vm::Result Vm::scan(uint32_t now) {
    if (!program_) return DONE;
    now_ = now;
    if (suspended_) {
        // Resume after WAIT once the delay has elapsed.
        if (int32_t(now - waitingUntil_) < 0) return WAITING;
        suspended_ = false;
        waitingUntil_ = 0;
        scanStart_ = host_ ? host_->watchdogMillis() : now;
        return exec();
    }
    if (program_->main == 0xFFFF) return DONE;
    return run(program_->main, now);
}

Vm::Result Vm::run(uint16_t function, uint32_t now) {
    now_ = now;
    scanStart_ = host_ ? host_->watchdogMillis() : now;
    sp_ = depth_ = 0;
    backJumps_ = 0;
    if (!enter(function, 0)) return trap(uint8_t(Trap::TRAP_BAD_PROGRAM));
    return exec();
}

bool Vm::enter(uint16_t function, uint32_t instanceBase) {
    if (function >= program_->funcCount) return false;
    if (depth_ >= VPLC_MAX_CALL_DEPTH) return false;
    frames_[depth_++] = Frame{pc_, ib_, function_};
    function_ = function;
    ib_ = instanceBase;
    pc_ = program_->funcCode(function);
    // Temporaries are reset on every call
    uint32_t frame = program_->funcFrame(function), size = program_->funcFrameSize(function);
    if (size) memset(d_ + frame, 0, size);
    return true;
}

Vm::Result Vm::trap(uint8_t code) {
    fault_.code = code;
    fault_.pc = pc_;
    fault_.function = function_;
    uint16_t f = function_;
    fault_.line = program_ ? program_->lineAt(pc_, &f) : 0;
    fault_.function = f;
    sp_ = depth_ = 0;
    suspended_ = false;
    waitingUntil_ = 0;
    return TRAPPED;
}

uint8_t* Vm::resolve(uint8_t a, uint32_t offset, uint32_t size) {
    uint32_t limit;
    uint8_t* base;
    switch (Area(a)) {
        case Area::D: base = d_; limit = program_->dataSize; break;
        case Area::N: base = d_; limit = program_->dataSize; offset += ib_; break;
        case Area::I: base = i_; limit = program_->iSize; break;
        case Area::Q: base = q_; limit = program_->qSize; break;
        case Area::M: base = m_; limit = program_->mSize; break;
        case Area::C: base = const_cast<uint8_t*>(program_->consts.data); limit = program_->consts.size; break;
        default: return nullptr;
    }
    if (uint64_t(offset) + size > limit) return nullptr;
    return base + offset;
}

uint8_t* Vm::resolvePtr(int64_t ptr, uint32_t size) {
    Area a = areaOf(ptr);
    if (a == Area::N) return nullptr;  // pointers are always absolute
    return resolve(uint8_t(a), offsetOf(ptr), size);
}

bool Vm::loadValue(uint8_t type, const uint8_t* p, Cell& out) {
    switch (type) {
        case T_BOOL: out.i = p[0] != 0; return true;
        case T_U8: out.i = p[0]; return true;
        case T_I8: out.i = int8_t(p[0]); return true;
        case T_U16: out.i = uint16_t(rdbe(p, 2)); return true;
        case T_I16: out.i = int16_t(uint16_t(rdbe(p, 2))); return true;
        case T_U32: out.i = uint32_t(rdbe(p, 4)); return true;
        case T_I32: out.i = int32_t(uint32_t(rdbe(p, 4))); return true;
        case T_I64:
        case T_PTR:
        case T_U64: out.i = int64_t(rdbe(p, 8)); return true;
        case T_F32: {
            uint32_t bits = uint32_t(rdbe(p, 4));
            float f;
            memcpy(&f, &bits, 4);
            out.f = f;
            return true;
        }
        case T_F64: {
            uint64_t bits = rdbe(p, 8);
            double d;
            memcpy(&d, &bits, sizeof d < 8 ? sizeof d : 8);
            out.f = d;
            return true;
        }
        default: return false;
    }
}

void Vm::storeValue(uint8_t type, uint8_t* p, const Cell& v) {
    switch (type) {
        case T_BOOL: p[0] = v.i != 0; break;
        case T_U8:
        case T_I8: p[0] = uint8_t(v.i); break;
        case T_U16:
        case T_I16: wrbe(p, 2, uint64_t(v.i)); break;
        case T_U32:
        case T_I32: wrbe(p, 4, uint64_t(v.i)); break;
        case T_I64:
        case T_PTR:
        case T_U64: wrbe(p, 8, uint64_t(v.i)); break;
        case T_F32: {
            float f = float(v.f);
            uint32_t bits;
            memcpy(&bits, &f, 4);
            wrbe(p, 4, bits);
            break;
        }
        case T_F64: {
            uint64_t bits = 0;
            double d = v.f;
            memcpy(&bits, &d, sizeof d < 8 ? sizeof d : 8);
            wrbe(p, 8, bits);
            break;
        }
        default: break;
    }
}

uint8_t* Vm::str(int64_t ptr) {
    uint8_t* s = resolvePtr(ptr, 2);
    if (!s) return nullptr;
    uint8_t max = areaOf(ptr) == Area::C ? s[0] : s[0];
    if (!resolvePtr(ptr, 2u + max)) return nullptr;
    if (s[1] > max) s[1] = max;
    return s;
}

#define FETCH8() (code[pc_++])
#define FETCH16() (pc_ += 2, rd16le(code + pc_ - 2))
#define FETCH32() (pc_ += 4, rd32le(code + pc_ - 4))
#define POP() (stack_[--sp_])
#define NEED(n) do { if (sp_ < (n)) return trap(uint8_t(Trap::TRAP_STACK_UNDERFLOW)); } while (0)
#define PUSH(c) do { if (!push(c)) return trap(uint8_t(Trap::TRAP_STACK_OVERFLOW)); } while (0)
#define PUSHI(v) do { Cell c_; c_.i = (v); PUSH(c_); } while (0)
#define PUSHF(v) do { Cell c_; c_.f = (v); PUSH(c_); } while (0)
#define TRAP(t) return trap(uint8_t(Trap::t))

Vm::Result Vm::exec() {
    const uint8_t* code = program_->code.data;
    const uint32_t codeSize = program_->code.size;

    for (;;) {
        if (pc_ >= codeSize) TRAP(TRAP_BAD_PROGRAM);
        uint32_t at = pc_;
        uint8_t op = FETCH8();
        int operands = operandBytes(op);
        if (operands < 0) {
            pc_ = at;
            TRAP(TRAP_BAD_OPCODE);
        }
        if (pc_ + uint32_t(operands) > codeSize) TRAP(TRAP_BAD_PROGRAM);
        switch (Op(op)) {
            case Op::OP_NOP: break;

            case Op::OP_PUSH_I32: {
                PUSHI(int32_t(FETCH32()));
                break;
            }
            case Op::OP_PUSH_I64: {
                uint64_t v = rd64le(code + pc_);
                pc_ += 8;
                PUSHI(int64_t(v));
                break;
            }
            case Op::OP_PUSH_F64: {
                uint64_t bits = rd64le(code + pc_);
                pc_ += 8;
                double d;
                memcpy(&d, &bits, sizeof d < 8 ? sizeof d : 8);
                PUSHF(d);
                break;
            }
            case Op::OP_PUSH_ADDR: {
                uint8_t a = FETCH8();
                uint32_t off = FETCH32();
                if (Area(a) == Area::N) {
                    a = uint8_t(Area::D);
                    off += ib_;
                }
                PUSHI(makePtr(a, off));
                break;
            }
            case Op::OP_POP: NEED(1); sp_--; break;
            case Op::OP_DUP: { NEED(1); Cell c = stack_[sp_ - 1]; PUSH(c); break; }
            case Op::OP_SWAP: { NEED(2); Cell c = stack_[sp_ - 1]; stack_[sp_ - 1] = stack_[sp_ - 2]; stack_[sp_ - 2] = c; break; }

            case Op::OP_LOAD:
            case Op::OP_STORE: {
                uint8_t type = FETCH8();
                uint8_t a = FETCH8();
                uint32_t off = FETCH32();
                if (type > T_U64) TRAP(TRAP_BAD_PROGRAM);
                uint8_t* p = resolve(a, off, VM_TYPE_SIZE[type]);
                if (!p) TRAP(TRAP_BAD_ADDRESS);
                if (Op(op) == Op::OP_LOAD) {
                    Cell c;
                    loadValue(type, p, c);
                    PUSH(c);
                } else {
                    NEED(1);
                    storeValue(type, p, POP());
                }
                break;
            }
            case Op::OP_LOAD_BIT:
            case Op::OP_STORE_BIT: {
                uint8_t a = FETCH8();
                uint32_t off = FETCH32();
                uint8_t bit = FETCH8() & 7;
                uint8_t* p = resolve(a, off, 1);
                if (!p) TRAP(TRAP_BAD_ADDRESS);
                if (Op(op) == Op::OP_LOAD_BIT) {
                    PUSHI((*p >> bit) & 1);
                } else {
                    NEED(1);
                    if (POP().i) *p |= uint8_t(1u << bit);
                    else *p &= uint8_t(~(1u << bit));
                }
                break;
            }
            case Op::OP_LOAD_IND: {
                uint8_t type = FETCH8();
                NEED(1);
                if (type > T_U64) TRAP(TRAP_BAD_PROGRAM);
                uint8_t* p = resolvePtr(stack_[sp_ - 1].i, VM_TYPE_SIZE[type]);
                if (!p) TRAP(TRAP_BAD_ADDRESS);
                loadValue(type, p, stack_[sp_ - 1]);
                break;
            }
            case Op::OP_STORE_IND: {
                uint8_t type = FETCH8();
                NEED(2);
                if (type > T_U64) TRAP(TRAP_BAD_PROGRAM);
                Cell v = POP();
                uint8_t* p = resolvePtr(POP().i, VM_TYPE_SIZE[type]);
                if (!p) TRAP(TRAP_BAD_ADDRESS);
                storeValue(type, p, v);
                break;
            }
            case Op::OP_INDEX: {
                uint32_t elem = FETCH32();
                int32_t low = int32_t(FETCH32());
                int32_t high = int32_t(FETCH32());
                NEED(2);
                int64_t index = POP().i;
                if (index < low || index > high) TRAP(TRAP_BOUNDS);
                stack_[sp_ - 1].i += int64_t(index - low) * elem;
                break;
            }
            case Op::OP_COPY: {
                uint32_t size = FETCH32();
                NEED(2);
                int64_t src = POP().i, dst = POP().i;
                uint8_t* s = resolvePtr(src, size);
                uint8_t* d = resolvePtr(dst, size);
                if (!s || !d) TRAP(TRAP_BAD_ADDRESS);
                memmove(d, s, size);
                break;
            }
            case Op::OP_OFFSET: {
                uint32_t off = FETCH32();
                NEED(1);
                stack_[sp_ - 1].i += off;
                break;
            }

            // ---- integer arithmetic
            case Op::OP_ADD: { NEED(2); int64_t b = POP().i; stack_[sp_ - 1].i = int64_t(uint64_t(stack_[sp_ - 1].i) + uint64_t(b)); break; }
            case Op::OP_SUB: { NEED(2); int64_t b = POP().i; stack_[sp_ - 1].i = int64_t(uint64_t(stack_[sp_ - 1].i) - uint64_t(b)); break; }
            case Op::OP_MUL: { NEED(2); int64_t b = POP().i; stack_[sp_ - 1].i = int64_t(uint64_t(stack_[sp_ - 1].i) * uint64_t(b)); break; }
            case Op::OP_DIV:
            case Op::OP_MOD: {
                NEED(2);
                int64_t b = POP().i;
                int64_t a = stack_[sp_ - 1].i;
                if (b == 0) TRAP(TRAP_DIV_ZERO);
                if (b == -1) stack_[sp_ - 1].i = Op(op) == Op::OP_DIV ? int64_t(0 - uint64_t(a)) : 0;
                else stack_[sp_ - 1].i = Op(op) == Op::OP_DIV ? a / b : a % b;
                break;
            }
            case Op::OP_NEG: NEED(1); stack_[sp_ - 1].i = int64_t(0 - uint64_t(stack_[sp_ - 1].i)); break;
            case Op::OP_AND: { NEED(2); int64_t b = POP().i; stack_[sp_ - 1].i &= b; break; }
            case Op::OP_OR: { NEED(2); int64_t b = POP().i; stack_[sp_ - 1].i |= b; break; }
            case Op::OP_XOR: { NEED(2); int64_t b = POP().i; stack_[sp_ - 1].i ^= b; break; }
            case Op::OP_NOT: NEED(1); stack_[sp_ - 1].i = ~stack_[sp_ - 1].i; break;
            case Op::OP_LNOT: NEED(1); stack_[sp_ - 1].i = stack_[sp_ - 1].i == 0; break;
            case Op::OP_SHL: {
                NEED(2);
                int64_t n = POP().i;
                stack_[sp_ - 1].i = n < 0 || n > 63 ? 0 : int64_t(uint64_t(stack_[sp_ - 1].i) << n);
                break;
            }
            case Op::OP_SHR: {
                NEED(2);
                int64_t n = POP().i;
                stack_[sp_ - 1].i = n < 0 || n > 63 ? 0 : int64_t(uint64_t(stack_[sp_ - 1].i) >> n);
                break;
            }
            case Op::OP_ABS: { NEED(1); int64_t v = stack_[sp_ - 1].i; stack_[sp_ - 1].i = v < 0 ? int64_t(0 - uint64_t(v)) : v; break; }
            case Op::OP_WRAP: { uint8_t type = FETCH8(); NEED(1); stack_[sp_ - 1].i = wrapTo(type, stack_[sp_ - 1].i); break; }
            case Op::OP_BOOL: NEED(1); stack_[sp_ - 1].i = stack_[sp_ - 1].i != 0; break;

            // ---- float arithmetic
            case Op::OP_FADD: { NEED(2); double b = POP().f; stack_[sp_ - 1].f += b; break; }
            case Op::OP_FSUB: { NEED(2); double b = POP().f; stack_[sp_ - 1].f -= b; break; }
            case Op::OP_FMUL: { NEED(2); double b = POP().f; stack_[sp_ - 1].f *= b; break; }
            case Op::OP_FDIV: {
                NEED(2);
                double b = POP().f;
                if (b == 0.0) TRAP(TRAP_DIV_ZERO);
                stack_[sp_ - 1].f /= b;
                break;
            }
            case Op::OP_FNEG: NEED(1); stack_[sp_ - 1].f = -stack_[sp_ - 1].f; break;
            case Op::OP_FPOW: { NEED(2); double b = POP().f; stack_[sp_ - 1].f = pow(stack_[sp_ - 1].f, b); break; }
            case Op::OP_FABS: NEED(1); stack_[sp_ - 1].f = fabs(stack_[sp_ - 1].f); break;
            case Op::OP_FMATH: {
                uint8_t fn = FETCH8();
                NEED(1);
                double x = stack_[sp_ - 1].f, r;
                switch (MathFn(fn)) {
                    case MathFn::M_SQRT: r = sqrt(x); break;
                    case MathFn::M_EXP: r = exp(x); break;
                    case MathFn::M_LN: r = log(x); break;
                    case MathFn::M_SIN: r = sin(x); break;
                    case MathFn::M_COS: r = cos(x); break;
                    case MathFn::M_TAN: r = tan(x); break;
                    case MathFn::M_ASIN: r = asin(x); break;
                    case MathFn::M_ACOS: r = acos(x); break;
                    case MathFn::M_ATAN: r = atan(x); break;
                    case MathFn::M_CEIL: r = ceil(x); break;
                    case MathFn::M_FLOOR: r = floor(x); break;
                    case MathFn::M_FRAC: r = x - trunc(x); break;
                    case MathFn::M_ROUND: r = roundEven(x); break;
                    case MathFn::M_TRUNC: r = trunc(x); break;
                    default: TRAP(TRAP_BAD_PROGRAM);
                }
                stack_[sp_ - 1].f = r;
                break;
            }
            case Op::OP_I2F: NEED(1); stack_[sp_ - 1].f = double(stack_[sp_ - 1].i); break;
            case Op::OP_F2I_ROUND: NEED(1); stack_[sp_ - 1].i = toInt(roundEven(stack_[sp_ - 1].f)); break;
            case Op::OP_F2I_TRUNC: NEED(1); stack_[sp_ - 1].i = toInt(trunc(stack_[sp_ - 1].f)); break;
            case Op::OP_F32: NEED(1); stack_[sp_ - 1].f = double(float(stack_[sp_ - 1].f)); break;

            // ---- comparisons
            case Op::OP_EQ: case Op::OP_NE: case Op::OP_LT: case Op::OP_LE: case Op::OP_GT: case Op::OP_GE: {
                NEED(2);
                int64_t b = POP().i, a = stack_[sp_ - 1].i;
                bool r;
                switch (Op(op)) {
                    case Op::OP_EQ: r = a == b; break;
                    case Op::OP_NE: r = a != b; break;
                    case Op::OP_LT: r = a < b; break;
                    case Op::OP_LE: r = a <= b; break;
                    case Op::OP_GT: r = a > b; break;
                    default: r = a >= b; break;
                }
                stack_[sp_ - 1].i = r;
                break;
            }
            case Op::OP_FEQ: case Op::OP_FNE: case Op::OP_FLT: case Op::OP_FLE: case Op::OP_FGT: case Op::OP_FGE: {
                NEED(2);
                double b = POP().f, a = stack_[sp_ - 1].f;
                bool r;
                switch (Op(op)) {
                    case Op::OP_FEQ: r = a == b; break;
                    case Op::OP_FNE: r = a != b; break;
                    case Op::OP_FLT: r = a < b; break;
                    case Op::OP_FLE: r = a <= b; break;
                    case Op::OP_FGT: r = a > b; break;
                    default: r = a >= b; break;
                }
                stack_[sp_ - 1].i = r;
                break;
            }
            case Op::OP_SCMP: {
                NEED(2);
                uint8_t* b = str(POP().i);
                uint8_t* a = str(stack_[sp_ - 1].i);
                if (!a || !b) TRAP(TRAP_BAD_ADDRESS);
                uint8_t n = a[1] < b[1] ? a[1] : b[1];
                int c = memcmp(a + 2, b + 2, n);
                if (c == 0) c = int(a[1]) - int(b[1]);
                stack_[sp_ - 1].i = c < 0 ? -1 : c > 0 ? 1 : 0;
                break;
            }

            // ---- control flow
            case Op::OP_JMP:
            case Op::OP_JZ:
            case Op::OP_JNZ: {
                int32_t rel = int32_t(FETCH32());
                bool take = true;
                if (Op(op) != Op::OP_JMP) {
                    NEED(1);
                    int64_t v = POP().i;
                    take = Op(op) == Op::OP_JZ ? v == 0 : v != 0;
                }
                if (take) {
                    if (rel < 0 && watchdogMs_ && ++backJumps_ >= VPLC_WATCHDOG_STRIDE) {
                        backJumps_ = 0;
                        if (host_ && host_->watchdogMillis() - scanStart_ > watchdogMs_) TRAP(TRAP_WATCHDOG);
                    }
                    pc_ = uint32_t(int64_t(pc_) + rel);
                }
                break;
            }
            case Op::OP_CALL: {
                uint16_t f = FETCH16();
                if (depth_ >= VPLC_MAX_CALL_DEPTH) TRAP(TRAP_CALL_DEPTH);
                if (!enter(f, ib_)) TRAP(TRAP_BAD_PROGRAM);
                break;
            }
            case Op::OP_CALL_FB: {
                uint16_t f = FETCH16();
                NEED(1);
                int64_t ptr = POP().i;
                if (areaOf(ptr) != Area::D) TRAP(TRAP_BAD_ADDRESS);
                if (depth_ >= VPLC_MAX_CALL_DEPTH) TRAP(TRAP_CALL_DEPTH);
                if (!enter(f, offsetOf(ptr))) TRAP(TRAP_BAD_PROGRAM);
                break;
            }
            case Op::OP_RET: {
                if (depth_ <= 1) {
                    // Returning from the entry function
                    depth_ = 0;
                    return DONE;
                }
                Frame fr = frames_[--depth_];
                pc_ = fr.returnPc;
                ib_ = fr.instanceBase;
                function_ = fr.function;
                break;
            }
            case Op::OP_HALT:
                depth_ = 0;
                return DONE;
            case Op::OP_CALL_LIB: {
                uint8_t block = FETCH8();
                NEED(1);
                int64_t ptr = POP().i;
                uint8_t* inst = resolvePtr(ptr, 1);
                if (!inst) TRAP(TRAP_BAD_ADDRESS);
                if (!library(block, inst)) TRAP(TRAP_BAD_ADDRESS);
                break;
            }
            case Op::OP_CALL_STD: {
                uint8_t fn = FETCH8();
                uint8_t argc = FETCH8();
                NEED(argc);
                if (!std(fn, argc)) {
                    if (fault_.code == 0) TRAP(TRAP_BAD_ADDRESS);
                    return trap(fault_.code);
                }
                break;
            }
            case Op::OP_SYS: {
                uint8_t fn = FETCH8();
                uint8_t argc = FETCH8();
                NEED(argc);
                bool suspend = false;
                if (!sys(fn, argc, suspend)) TRAP(TRAP_BAD_PROGRAM);
                if (suspend) return WAITING;
                break;
            }
            case Op::OP_TRAP: return trap(FETCH8());
            default:
                pc_ = at;
                TRAP(TRAP_BAD_OPCODE);
        }
    }
}

// ---------------------------------------------------------------------------
// Standard functions
// ---------------------------------------------------------------------------

static void formatInt(char* buf, size_t n, int64_t v) {
    char tmp[24];
    int i = 0;
    uint64_t u = v < 0 ? uint64_t(0) - uint64_t(v) : uint64_t(v);
    do { tmp[i++] = char('0' + u % 10); u /= 10; } while (u && i < 22);
    size_t o = 0;
    if (v < 0 && o + 1 < n) buf[o++] = '-';
    while (i > 0 && o + 1 < n) buf[o++] = tmp[--i];
    buf[o] = 0;
}

static void formatReal(char* buf, size_t n, double v) {
    if (v != v) { snprintf(buf, n, "NaN"); return; }
    // Shortest representation that round-trips a REAL (7 significant digits)
    snprintf(buf, n, "%.7g", v);
}

bool Vm::std(uint8_t fn, uint8_t argc) {
    Cell* a = &stack_[sp_ - argc];
    Cell result;
    bool hasResult = true;
    switch (StdFn(fn)) {
        case StdFn::S_MIN:
        case StdFn::S_MAX: {
            result = a[0];
            for (uint8_t k = 1; k < argc; k++) {
                if (StdFn(fn) == StdFn::S_MIN ? a[k].i < result.i : a[k].i > result.i) result = a[k];
            }
            break;
        }
        case StdFn::S_FMIN:
        case StdFn::S_FMAX: {
            result = a[0];
            for (uint8_t k = 1; k < argc; k++) {
                if (StdFn(fn) == StdFn::S_FMIN ? a[k].f < result.f : a[k].f > result.f) result = a[k];
            }
            break;
        }
        case StdFn::S_LIMIT:
            if (argc != 3) return false;
            result.i = a[1].i < a[0].i ? a[0].i : a[1].i > a[2].i ? a[2].i : a[1].i;
            break;
        case StdFn::S_FLIMIT:
            if (argc != 3) return false;
            result.f = a[1].f < a[0].f ? a[0].f : a[1].f > a[2].f ? a[2].f : a[1].f;
            break;
        case StdFn::S_SEL:
            if (argc != 3) return false;
            result = a[0].i ? a[2] : a[1];
            break;
        case StdFn::S_MUX: {
            int64_t k = a[0].i;
            if (k < 0 || k >= int64_t(argc) - 1) { fault_.code = uint8_t(Trap::TRAP_BOUNDS); return false; }
            result = a[1 + k];
            break;
        }
        case StdFn::S_SWAP: {
            // byte order of a 2, 4 or 8-byte value (EtherNet/IP and Modbus data are little endian)
            if (argc != 2) return false;
            uint64_t v = uint64_t(a[0].i), r = 0;
            int n = int(a[1].i);
            for (int k = 0; k < n; k++) r |= ((v >> (8 * k)) & 0xFF) << (8 * (n - 1 - k));
            result.i = int64_t(r);
            break;
        }
        case StdFn::S_NORM_X:
        case StdFn::S_SCALE_X: {
            if (argc != 3) return false;
            double mn = a[0].f, v = a[1].f, mx = a[2].f;
            if (StdFn(fn) == StdFn::S_NORM_X) result.f = mx == mn ? 0.0 : (v - mn) / (mx - mn);
            else result.f = v * (mx - mn) + mn;
            break;
        }
        case StdFn::S_SASSIGN: {
            if (argc != 2) return false;
            uint8_t* d = str(a[0].i);
            uint8_t* s = str(a[1].i);
            if (!d || !s || areaOf(a[0].i) == Area::C) return false;
            uint8_t n = s[1] < d[0] ? s[1] : d[0];
            memmove(d + 2, s + 2, n);
            d[1] = n;
            hasResult = false;
            break;
        }
        case StdFn::S_CONCAT: {
            uint8_t* d = str(a[0].i);
            if (!d || areaOf(a[0].i) == Area::C) return false;
            uint8_t len = 0;
            for (uint8_t k = 1; k < argc; k++) {
                uint8_t* s = str(a[k].i);
                if (!s) return false;
                uint8_t n = s[1];
                if (len + n > d[0]) n = uint8_t(d[0] - len);
                memmove(d + 2 + len, s + 2, n);
                len = uint8_t(len + n);
            }
            d[1] = len;
            result = a[0];
            break;
        }
        case StdFn::S_LEN: {
            uint8_t* s = str(a[0].i);
            if (!s) return false;
            result.i = s[1];
            break;
        }
        case StdFn::S_I2S:
        case StdFn::S_F2S:
        case StdFn::S_B2S: {
            if (argc != 2) return false;
            uint8_t* d = str(a[0].i);
            if (!d || areaOf(a[0].i) == Area::C) return false;
            char buf[40];
            if (StdFn(fn) == StdFn::S_I2S) formatInt(buf, sizeof buf, a[1].i);
            else if (StdFn(fn) == StdFn::S_F2S) formatReal(buf, sizeof buf, a[1].f);
            else snprintf(buf, sizeof buf, "%s", a[1].i ? "TRUE" : "FALSE");
            size_t n = strlen(buf);
            if (n > d[0]) n = d[0];
            memcpy(d + 2, buf, n);
            d[1] = uint8_t(n);
            result = a[0];
            break;
        }
        case StdFn::S_C2S: {  // (dest string, character code)
            if (argc != 2) return false;
            uint8_t* d = str(a[0].i);
            if (!d || areaOf(a[0].i) == Area::C) return false;
            d[1] = d[0] ? 1 : 0;
            if (d[0]) d[2] = uint8_t(a[1].i);
            result = a[0];
            break;
        }
        case StdFn::S_S2C: {  // first character of a string (0 if empty)
            uint8_t* s = str(a[0].i);
            if (!s) return false;
            result.i = s[1] ? s[2] : 0;
            break;
        }
        case StdFn::S_DT2LDT: {  // DATE_AND_TIME (BCD) -> LDT (ns since 1970)
            uint8_t b[8];
            wrbe(b, 8, uint64_t(a[0].i));
            unsigned yy = unbcd(b[0]);
            unsigned ms = unbcd(b[6]) * 10 + (b[7] >> 4);
            result.i = joinLdt(yy >= 90 ? 1900 + yy : 2000 + yy, unbcd(b[1]), unbcd(b[2]), unbcd(b[3]), unbcd(b[4]), unbcd(b[5]), ms * 1000000u);
            break;
        }
        case StdFn::S_LDT2DT: {  // LDT -> DATE_AND_TIME (BCD, 1990..2089)
            Civil c = splitLdt(a[0].i);
            uint8_t b[8];
            unsigned ms = c.ns / 1000000u;
            b[0] = bcd(unsigned(c.year % 100));
            b[1] = bcd(c.month);
            b[2] = bcd(c.day);
            b[3] = bcd(c.hour);
            b[4] = bcd(c.minute);
            b[5] = bcd(c.second);
            b[6] = bcd(ms / 10);
            b[7] = uint8_t((ms % 10) << 4 | c.weekday);
            result.i = int64_t(rdbe(b, 8));
            break;
        }
        case StdFn::S_DTL2LDT: {  // DTL (12 bytes) -> LDT
            uint8_t* p = resolvePtr(a[0].i, 12);
            if (!p) return false;
            result.i = joinLdt(int64_t(rdbe(p, 2)), p[2], p[3], p[5], p[6], p[7], uint32_t(rdbe(p + 8, 4)));
            break;
        }
        case StdFn::S_LDT2DTL: {  // (DTL destination, LDT)
            if (argc != 2) return false;
            uint8_t* p = resolvePtr(a[0].i, 12);
            if (!p || areaOf(a[0].i) == Area::C) return false;
            Civil c = splitLdt(a[1].i);
            wrbe(p, 2, uint64_t(c.year));
            p[2] = uint8_t(c.month);
            p[3] = uint8_t(c.day);
            p[4] = uint8_t(c.weekday);
            p[5] = uint8_t(c.hour);
            p[6] = uint8_t(c.minute);
            p[7] = uint8_t(c.second);
            wrbe(p + 8, 4, c.ns);
            hasResult = false;
            break;
        }
        case StdFn::S_S2I:
        case StdFn::S_S2F: {
            uint8_t* s = str(a[0].i);
            if (!s) return false;
            char buf[64];
            uint8_t n = s[1] < 63 ? s[1] : 63;
            memcpy(buf, s + 2, n);
            buf[n] = 0;
            if (StdFn(fn) == StdFn::S_S2I) result.i = strtoll(buf, nullptr, 10);
            else result.f = strtod(buf, nullptr);
            break;
        }
        default:
            return false;
    }
    sp_ = uint16_t(sp_ - argc);
    if (hasResult) stack_[sp_++] = result;
    return true;
}

bool Vm::sys(uint8_t fn, uint8_t argc, bool& suspend) {
    Cell* a = &stack_[sp_ - argc];
    switch (SysFn(fn)) {
        case SysFn::SYS_LOG: {
            char msg[VPLC_LOG_LENGTH];
            size_t len = 0;
            for (uint8_t k = 0; k < argc; k++) {
                uint8_t* s = str(a[k].i);
                if (!s) return false;
                size_t n = s[1];
                if (len + n >= sizeof msg) n = sizeof msg - 1 - len;
                memcpy(msg + len, s + 2, n);
                len += n;
            }
            msg[len] = 0;
            if (host_) host_->log(msg);
            sp_ = uint16_t(sp_ - argc);
            return true;
        }
        case SysFn::SYS_WAIT: {
            if (argc != 1) return false;
            int64_t ms = a[0].i;
            sp_--;
            if (ms < 0) ms = 0;
            waitingUntil_ = now_ + uint32_t(ms);
            if (waitingUntil_ == 0) waitingUntil_ = 1;
            suspended_ = true;
            suspend = true;
            return true;
        }
        case SysFn::SYS_MILLIS: {
            Cell c;
            c.i = now_;
            return push(c);
        }
        case SysFn::SYS_CLOCK: {  // (local) -> LDT: ns since 1970, UTC or local time
            if (argc != 1) return false;
            int64_t ns = 0;
            if (!host_ || !host_->clock(a[0].i != 0, ns)) ns = 0;
            a[0].i = ns;
            return true;
        }
        case SysFn::SYS_DEVICE_OK: {
            if (argc != 1) return false;
            a[0].i = host_ ? host_->moduleOk(uint16_t(a[0].i)) : 0;
            return true;
        }
        case SysFn::SYS_DATALOG_WRITE: {
            if (argc != 1) return false;
            a[0].i = host_ ? host_->dataLogRequest(uint16_t(a[0].i)) : 0;
            return true;
        }
        case SysFn::SYS_DEVICE_DIAG: {
            if (argc != 1) return false;
            a[0].i = host_ ? host_->moduleDiag(uint16_t(a[0].i)) : 0;
            return true;
        }
        case SysFn::SYS_PN_ALARM: {  // (module, slot, kind, code) -> accepted
            if (argc != 4) return false;
            a[0].i = host_ ? host_->alarm(uint16_t(a[0].i), uint16_t(a[1].i), uint16_t(a[2].i), uint32_t(a[3].i)) : 0;
            sp_ = uint16_t(sp_ - 3);
            return true;
        }
        default:
            return false;
    }
}

// ---------------------------------------------------------------------------
// Library function blocks (layouts in spec/isa.json)
// ---------------------------------------------------------------------------

bool Vm::library(uint8_t block, uint8_t* inst) {
    uint32_t size;
    switch (LibBlock(block)) {
        case LibBlock::LIB_TON: case LibBlock::LIB_TOF: case LibBlock::LIB_TP: size = lib_ton::SIZE; break;
        case LibBlock::LIB_R_TRIG: case LibBlock::LIB_F_TRIG: size = lib_r_trig::SIZE; break;
        case LibBlock::LIB_CTU: case LibBlock::LIB_CTD: size = lib_ctu::SIZE; break;
        case LibBlock::LIB_CTUD: size = lib_ctud::SIZE; break;
        default: return false;
    }
    // Bounds of the whole instance (inst was resolved for 1 byte only)
    if (inst + size > d_ + program_->dataSize || inst < d_) return false;

    switch (LibBlock(block)) {
        case LibBlock::LIB_TON:
        case LibBlock::LIB_TOF:
        case LibBlock::LIB_TP: {
            using namespace lib_ton;
            bool in = inst[IN] != 0;
            int32_t pt = int32_t(rdbe(inst + PT, 4));
            if (pt < 0) pt = 0;
            uint32_t start = uint32_t(rdbe(inst + START, 4));
            uint8_t flags = inst[FLAGS];
            bool running = flags & 1, lastIn = flags & 2;
            bool q = inst[Q] != 0;
            int32_t et = int32_t(rdbe(inst + ET, 4));
            bool rising = in && !lastIn, falling = !in && lastIn;
            uint32_t now = now_;
            auto elapsed = [&]() -> int32_t {
                uint32_t e = now - start;
                return e > uint32_t(pt) ? pt : int32_t(e);
            };
            if (LibBlock(block) == LibBlock::LIB_TON) {
                if (!in) { running = false; q = false; et = 0; }
                else {
                    if (rising || !running) { running = true; start = now; }
                    et = elapsed();
                    q = et >= pt;
                }
            } else if (LibBlock(block) == LibBlock::LIB_TOF) {
                if (in) { running = false; q = true; et = 0; }
                else {
                    if (falling) { running = true; start = now; }
                    if (running) {
                        et = elapsed();
                        if (et >= pt) { running = false; q = false; }
                    }
                }
            } else {
                if (rising && !running && !q) { running = true; start = now; q = true; }
                if (running) {
                    et = elapsed();
                    if (et >= pt) { running = false; q = false; }
                }
                if (!in && !running) et = 0;
            }
            inst[Q] = q;
            wrbe(inst + ET, 4, uint32_t(et));
            wrbe(inst + START, 4, start);
            inst[FLAGS] = uint8_t((running ? 1 : 0) | (in ? 2 : 0));
            return true;
        }
        case LibBlock::LIB_R_TRIG:
        case LibBlock::LIB_F_TRIG: {
            using namespace lib_r_trig;
            bool clk = inst[CLK] != 0, mem = inst[MEM] != 0;
            inst[Q] = LibBlock(block) == LibBlock::LIB_R_TRIG ? (clk && !mem) : (!clk && mem);
            inst[MEM] = clk;
            return true;
        }
        case LibBlock::LIB_CTU:
        case LibBlock::LIB_CTD: {
            // CTU: CU@0 R@1 Q@2 PV@3 CV@5 last@7 / CTD: CD@0 LD@1 (same offsets)
            bool count = inst[0] != 0, reset = inst[1] != 0;
            bool edge = count && !inst[7];
            inst[7] = count;
            int16_t pv = int16_t(uint16_t(rdbe(inst + 3, 2)));
            int16_t cv = int16_t(uint16_t(rdbe(inst + 5, 2)));
            if (LibBlock(block) == LibBlock::LIB_CTU) {
                if (reset) cv = 0;
                else if (edge && cv < 32767) cv++;
                inst[2] = cv >= pv;
            } else {
                if (reset) cv = pv;  // LD
                else if (edge && cv > -32768) cv--;
                inst[2] = cv <= 0;
            }
            wrbe(inst + 5, 2, uint16_t(cv));
            return true;
        }
        case LibBlock::LIB_CTUD: {
            using namespace lib_ctud;
            bool cu = inst[CU] != 0, cd = inst[CD] != 0;
            bool up = cu && !inst[LASTU], down = cd && !inst[LASTD];
            inst[LASTU] = cu;
            inst[LASTD] = cd;
            int16_t pv = int16_t(uint16_t(rdbe(inst + PV, 2)));
            int16_t cv = int16_t(uint16_t(rdbe(inst + CV, 2)));
            if (inst[R]) cv = 0;
            else if (inst[LD]) cv = pv;
            else {
                if (up && cv < 32767) cv++;
                if (down && cv > -32768) cv--;
            }
            wrbe(inst + CV, 2, uint16_t(cv));
            inst[QU] = cv >= pv;
            inst[QD] = cv <= 0;
            return true;
        }
        default:
            return false;
    }
}

}  // namespace vplc
