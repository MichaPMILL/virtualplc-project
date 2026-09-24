// Generated from spec/isa.json by tools/gen-isa.mjs - do not edit.
#pragma once
#include <cstdint>

namespace vplc {

constexpr uint16_t ISA_VERSION = 1;
constexpr uint16_t PROTOCOL_PORT = 20105;

enum class Area : uint8_t {
    D = 0,
    N = 1,
    I = 2,
    Q = 3,
    M = 4,
    C = 5,
};

enum class VmType : uint8_t {
    T_BOOL = 0,
    T_U8 = 1,
    T_I8 = 2,
    T_U16 = 3,
    T_I16 = 4,
    T_U32 = 5,
    T_I32 = 6,
    T_I64 = 7,
    T_F32 = 8,
    T_F64 = 9,
    T_PTR = 10,
    T_U64 = 11,
};

constexpr uint8_t VM_TYPE_SIZE[] = {1, 1, 1, 2, 2, 4, 4, 8, 4, 8, 8, 8};

enum class Op : uint8_t {
    OP_NOP = 0,
    OP_PUSH_I32 = 1,
    OP_PUSH_I64 = 2,
    OP_PUSH_F64 = 3,
    OP_PUSH_ADDR = 4,
    OP_POP = 5,
    OP_DUP = 6,
    OP_SWAP = 7,
    OP_LOAD = 16,
    OP_STORE = 17,
    OP_LOAD_BIT = 18,
    OP_STORE_BIT = 19,
    OP_LOAD_IND = 20,
    OP_STORE_IND = 21,
    OP_INDEX = 22,
    OP_COPY = 23,
    OP_OFFSET = 24,
    OP_ADD = 32,
    OP_SUB = 33,
    OP_MUL = 34,
    OP_DIV = 35,
    OP_MOD = 36,
    OP_NEG = 37,
    OP_AND = 38,
    OP_OR = 39,
    OP_XOR = 40,
    OP_NOT = 41,
    OP_LNOT = 42,
    OP_SHL = 43,
    OP_SHR = 44,
    OP_ABS = 45,
    OP_WRAP = 46,
    OP_BOOL = 47,
    OP_FADD = 48,
    OP_FSUB = 49,
    OP_FMUL = 50,
    OP_FDIV = 51,
    OP_FNEG = 52,
    OP_FPOW = 53,
    OP_FABS = 54,
    OP_FMATH = 55,
    OP_I2F = 56,
    OP_F2I_ROUND = 57,
    OP_F2I_TRUNC = 58,
    OP_F32 = 59,
    OP_EQ = 64,
    OP_NE = 65,
    OP_LT = 66,
    OP_LE = 67,
    OP_GT = 68,
    OP_GE = 69,
    OP_FEQ = 70,
    OP_FNE = 71,
    OP_FLT = 72,
    OP_FLE = 73,
    OP_FGT = 74,
    OP_FGE = 75,
    OP_SCMP = 76,
    OP_JMP = 80,
    OP_JZ = 81,
    OP_JNZ = 82,
    OP_CALL = 83,
    OP_CALL_FB = 84,
    OP_RET = 85,
    OP_CALL_LIB = 86,
    OP_CALL_STD = 87,
    OP_SYS = 88,
    OP_TRAP = 89,
    OP_HALT = 90,
};

enum class MathFn : uint8_t {
    M_SQRT = 0,
    M_EXP = 1,
    M_LN = 2,
    M_SIN = 3,
    M_COS = 4,
    M_TAN = 5,
    M_ASIN = 6,
    M_ACOS = 7,
    M_ATAN = 8,
    M_CEIL = 9,
    M_FLOOR = 10,
    M_FRAC = 11,
    M_ROUND = 12,
    M_TRUNC = 13,
};

enum class StdFn : uint8_t {
    S_MIN = 0,
    S_MAX = 1,
    S_LIMIT = 2,
    S_FMIN = 3,
    S_FMAX = 4,
    S_FLIMIT = 5,
    S_SEL = 6,
    S_MUX = 7,
    S_CONCAT = 8,
    S_LEN = 9,
    S_I2S = 10,
    S_F2S = 11,
    S_B2S = 12,
    S_S2I = 13,
    S_S2F = 14,
    S_SASSIGN = 15,
    S_NORM_X = 16,
    S_SCALE_X = 17,
    S_C2S = 18,
    S_S2C = 19,
    S_DT2LDT = 20,
    S_LDT2DT = 21,
    S_DTL2LDT = 22,
    S_LDT2DTL = 23,
};

enum class SysFn : uint8_t {
    SYS_LOG = 0,
    SYS_WAIT = 1,
    SYS_MILLIS = 2,
    SYS_DEVICE_OK = 3,
    SYS_CLOCK = 4,
};

enum class Trap : uint8_t {
    TRAP_NONE = 0,
    TRAP_DIV_ZERO = 1,
    TRAP_BOUNDS = 2,
    TRAP_STACK_OVERFLOW = 3,
    TRAP_STACK_UNDERFLOW = 4,
    TRAP_CALL_DEPTH = 5,
    TRAP_WATCHDOG = 6,
    TRAP_BAD_OPCODE = 7,
    TRAP_BAD_ADDRESS = 8,
    TRAP_MATH = 9,
    TRAP_BAD_PROGRAM = 10,
};

enum class Section : uint8_t {
    SEC_META = 1,
    SEC_LIMITS = 2,
    SEC_CODE = 3,
    SEC_CONST = 4,
    SEC_INIT = 5,
    SEC_FUNCS = 6,
    SEC_ENTRIES = 7,
    SEC_LINES = 8,
    SEC_IOCONF = 9,
    SEC_SYMS = 10,
    SEC_DBS = 11,
    SEC_SERVICES = 12,
};

enum class IoModule : uint8_t {
    IO_MODBUS_TCP = 1,
    IO_GPIO_DI = 2,
    IO_GPIO_DO = 3,
    IO_GPIO_AI = 4,
    IO_GPIO_AO = 5,
    IO_IOLINK_MASTER = 6,
};

enum class Command : uint8_t {
    CMD_INFO = 1,
    CMD_STATE = 2,
    CMD_STOP = 3,
    CMD_START = 4,
    CMD_DOWNLOAD_BEGIN = 5,
    CMD_DOWNLOAD_CHUNK = 6,
    CMD_DOWNLOAD_END = 7,
    CMD_READ = 8,
    CMD_WRITE = 9,
    CMD_FORCE = 10,
    CMD_UNFORCE_ALL = 11,
    CMD_LOGS = 12,
    CMD_UPLOAD = 13,
    CMD_AUTH = 14,
};

enum class Status : uint8_t {
    ST_OK = 0,
    ST_ERROR = 1,
    ST_BAD_REQUEST = 2,
    ST_BAD_STATE = 3,
    ST_BAD_CHECKSUM = 4,
    ST_TOO_LARGE = 5,
    ST_UNAUTHORIZED = 6,
};

enum class CpuState : uint8_t {
    CPU_NO_PROGRAM = 0,
    CPU_STOP = 1,
    CPU_RUN = 2,
    CPU_FAULT = 3,
};

enum class LibBlock : uint8_t {
    LIB_TON = 0,
    LIB_TOF = 1,
    LIB_TP = 2,
    LIB_R_TRIG = 3,
    LIB_F_TRIG = 4,
    LIB_CTU = 5,
    LIB_CTD = 6,
    LIB_CTUD = 7,
};

namespace lib_ton {
    constexpr uint32_t SIZE = 15;
    constexpr uint32_t IN = 0;
    constexpr uint32_t Q = 1;
    constexpr uint32_t PT = 2;
    constexpr uint32_t ET = 6;
    constexpr uint32_t START = 10;
    constexpr uint32_t FLAGS = 14;
}
namespace lib_tof {
    constexpr uint32_t SIZE = 15;
    constexpr uint32_t IN = 0;
    constexpr uint32_t Q = 1;
    constexpr uint32_t PT = 2;
    constexpr uint32_t ET = 6;
    constexpr uint32_t START = 10;
    constexpr uint32_t FLAGS = 14;
}
namespace lib_tp {
    constexpr uint32_t SIZE = 15;
    constexpr uint32_t IN = 0;
    constexpr uint32_t Q = 1;
    constexpr uint32_t PT = 2;
    constexpr uint32_t ET = 6;
    constexpr uint32_t START = 10;
    constexpr uint32_t FLAGS = 14;
}
namespace lib_r_trig {
    constexpr uint32_t SIZE = 3;
    constexpr uint32_t CLK = 0;
    constexpr uint32_t Q = 1;
    constexpr uint32_t MEM = 2;
}
namespace lib_f_trig {
    constexpr uint32_t SIZE = 3;
    constexpr uint32_t CLK = 0;
    constexpr uint32_t Q = 1;
    constexpr uint32_t MEM = 2;
}
namespace lib_ctu {
    constexpr uint32_t SIZE = 8;
    constexpr uint32_t CU = 0;
    constexpr uint32_t R = 1;
    constexpr uint32_t Q = 2;
    constexpr uint32_t PV = 3;
    constexpr uint32_t CV = 5;
    constexpr uint32_t LAST = 7;
}
namespace lib_ctd {
    constexpr uint32_t SIZE = 8;
    constexpr uint32_t CD = 0;
    constexpr uint32_t LD = 1;
    constexpr uint32_t Q = 2;
    constexpr uint32_t PV = 3;
    constexpr uint32_t CV = 5;
    constexpr uint32_t LAST = 7;
}
namespace lib_ctud {
    constexpr uint32_t SIZE = 12;
    constexpr uint32_t CU = 0;
    constexpr uint32_t CD = 1;
    constexpr uint32_t R = 2;
    constexpr uint32_t LD = 3;
    constexpr uint32_t QU = 4;
    constexpr uint32_t QD = 5;
    constexpr uint32_t PV = 6;
    constexpr uint32_t CV = 8;
    constexpr uint32_t LASTU = 10;
    constexpr uint32_t LASTD = 11;
}

// Size in bytes of the operands of an opcode (-1 = unknown opcode).
inline int operandBytes(uint8_t op) {
    switch (op) {
        case 0: return 0;
        case 1: return 4;
        case 2: return 8;
        case 3: return 8;
        case 4: return 5;
        case 5: return 0;
        case 6: return 0;
        case 7: return 0;
        case 16: return 6;
        case 17: return 6;
        case 18: return 6;
        case 19: return 6;
        case 20: return 1;
        case 21: return 1;
        case 22: return 12;
        case 23: return 4;
        case 24: return 4;
        case 32: return 0;
        case 33: return 0;
        case 34: return 0;
        case 35: return 0;
        case 36: return 0;
        case 37: return 0;
        case 38: return 0;
        case 39: return 0;
        case 40: return 0;
        case 41: return 0;
        case 42: return 0;
        case 43: return 0;
        case 44: return 0;
        case 45: return 0;
        case 46: return 1;
        case 47: return 0;
        case 48: return 0;
        case 49: return 0;
        case 50: return 0;
        case 51: return 0;
        case 52: return 0;
        case 53: return 0;
        case 54: return 0;
        case 55: return 1;
        case 56: return 0;
        case 57: return 0;
        case 58: return 0;
        case 59: return 0;
        case 64: return 0;
        case 65: return 0;
        case 66: return 0;
        case 67: return 0;
        case 68: return 0;
        case 69: return 0;
        case 70: return 0;
        case 71: return 0;
        case 72: return 0;
        case 73: return 0;
        case 74: return 0;
        case 75: return 0;
        case 76: return 0;
        case 80: return 4;
        case 81: return 4;
        case 82: return 4;
        case 83: return 2;
        case 84: return 2;
        case 85: return 0;
        case 86: return 1;
        case 87: return 2;
        case 88: return 2;
        case 89: return 1;
        case 90: return 0;
        default: return -1;
    }
}

inline const char* trapName(uint8_t code) {
    switch (code) {
        case 0: return "NONE";
        case 1: return "DIV_ZERO";
        case 2: return "BOUNDS";
        case 3: return "STACK_OVERFLOW";
        case 4: return "STACK_UNDERFLOW";
        case 5: return "CALL_DEPTH";
        case 6: return "WATCHDOG";
        case 7: return "BAD_OPCODE";
        case 8: return "BAD_ADDRESS";
        case 9: return "MATH";
        case 10: return "BAD_PROGRAM";
        default: return "UNKNOWN";
    }
}

}  // namespace vplc
