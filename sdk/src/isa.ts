// Generated from spec/isa.json by tools/gen-isa.mjs - do not edit.

export const ISA_VERSION = 1;
export const PROTOCOL_PORT = 20105;

export const Area = {
  D: 0,
  N: 1,
  I: 2,
  Q: 3,
  M: 4,
  C: 5,
} as const;

export const VmType = {
  BOOL: 0,
  U8: 1,
  I8: 2,
  U16: 3,
  I16: 4,
  U32: 5,
  I32: 6,
  I64: 7,
  F32: 8,
  F64: 9,
  PTR: 10,
  U64: 11,
} as const;

export const VM_TYPE_SIZE: Record<number, number> = {
  0: 1,
  1: 1,
  2: 1,
  3: 2,
  4: 2,
  5: 4,
  6: 4,
  7: 8,
  8: 4,
  9: 8,
  10: 8,
  11: 8,
};

export const Op = {
  NOP: 0,
  PUSH_I32: 1,
  PUSH_I64: 2,
  PUSH_F64: 3,
  PUSH_ADDR: 4,
  POP: 5,
  DUP: 6,
  SWAP: 7,
  LOAD: 16,
  STORE: 17,
  LOAD_BIT: 18,
  STORE_BIT: 19,
  LOAD_IND: 20,
  STORE_IND: 21,
  INDEX: 22,
  COPY: 23,
  OFFSET: 24,
  ADD: 32,
  SUB: 33,
  MUL: 34,
  DIV: 35,
  MOD: 36,
  NEG: 37,
  AND: 38,
  OR: 39,
  XOR: 40,
  NOT: 41,
  LNOT: 42,
  SHL: 43,
  SHR: 44,
  ABS: 45,
  WRAP: 46,
  BOOL: 47,
  FADD: 48,
  FSUB: 49,
  FMUL: 50,
  FDIV: 51,
  FNEG: 52,
  FPOW: 53,
  FABS: 54,
  FMATH: 55,
  I2F: 56,
  F2I_ROUND: 57,
  F2I_TRUNC: 58,
  F32: 59,
  EQ: 64,
  NE: 65,
  LT: 66,
  LE: 67,
  GT: 68,
  GE: 69,
  FEQ: 70,
  FNE: 71,
  FLT: 72,
  FLE: 73,
  FGT: 74,
  FGE: 75,
  SCMP: 76,
  JMP: 80,
  JZ: 81,
  JNZ: 82,
  CALL: 83,
  CALL_FB: 84,
  RET: 85,
  CALL_LIB: 86,
  CALL_STD: 87,
  SYS: 88,
  TRAP: 89,
  HALT: 90,
} as const;

export const OPERANDS: Record<number, readonly string[]> = {
  0: [],
  1: ['i32'],
  2: ['i64'],
  3: ['f64'],
  4: ['u8', 'u32'],
  5: [],
  6: [],
  7: [],
  16: ['u8', 'u8', 'u32'],
  17: ['u8', 'u8', 'u32'],
  18: ['u8', 'u32', 'u8'],
  19: ['u8', 'u32', 'u8'],
  20: ['u8'],
  21: ['u8'],
  22: ['u32', 'i32', 'i32'],
  23: ['u32'],
  24: ['u32'],
  32: [],
  33: [],
  34: [],
  35: [],
  36: [],
  37: [],
  38: [],
  39: [],
  40: [],
  41: [],
  42: [],
  43: [],
  44: [],
  45: [],
  46: ['u8'],
  47: [],
  48: [],
  49: [],
  50: [],
  51: [],
  52: [],
  53: [],
  54: [],
  55: ['u8'],
  56: [],
  57: [],
  58: [],
  59: [],
  64: [],
  65: [],
  66: [],
  67: [],
  68: [],
  69: [],
  70: [],
  71: [],
  72: [],
  73: [],
  74: [],
  75: [],
  76: [],
  80: ['i32'],
  81: ['i32'],
  82: ['i32'],
  83: ['u16'],
  84: ['u16'],
  85: [],
  86: ['u8'],
  87: ['u8', 'u8'],
  88: ['u8', 'u8'],
  89: ['u8'],
  90: [],
};

export const OP_NAMES: Record<number, string> = {
  0: 'NOP',
  1: 'PUSH_I32',
  2: 'PUSH_I64',
  3: 'PUSH_F64',
  4: 'PUSH_ADDR',
  5: 'POP',
  6: 'DUP',
  7: 'SWAP',
  16: 'LOAD',
  17: 'STORE',
  18: 'LOAD_BIT',
  19: 'STORE_BIT',
  20: 'LOAD_IND',
  21: 'STORE_IND',
  22: 'INDEX',
  23: 'COPY',
  24: 'OFFSET',
  32: 'ADD',
  33: 'SUB',
  34: 'MUL',
  35: 'DIV',
  36: 'MOD',
  37: 'NEG',
  38: 'AND',
  39: 'OR',
  40: 'XOR',
  41: 'NOT',
  42: 'LNOT',
  43: 'SHL',
  44: 'SHR',
  45: 'ABS',
  46: 'WRAP',
  47: 'BOOL',
  48: 'FADD',
  49: 'FSUB',
  50: 'FMUL',
  51: 'FDIV',
  52: 'FNEG',
  53: 'FPOW',
  54: 'FABS',
  55: 'FMATH',
  56: 'I2F',
  57: 'F2I_ROUND',
  58: 'F2I_TRUNC',
  59: 'F32',
  64: 'EQ',
  65: 'NE',
  66: 'LT',
  67: 'LE',
  68: 'GT',
  69: 'GE',
  70: 'FEQ',
  71: 'FNE',
  72: 'FLT',
  73: 'FLE',
  74: 'FGT',
  75: 'FGE',
  76: 'SCMP',
  80: 'JMP',
  81: 'JZ',
  82: 'JNZ',
  83: 'CALL',
  84: 'CALL_FB',
  85: 'RET',
  86: 'CALL_LIB',
  87: 'CALL_STD',
  88: 'SYS',
  89: 'TRAP',
  90: 'HALT',
};

export const MathFn = {
  SQRT: 0,
  EXP: 1,
  LN: 2,
  SIN: 3,
  COS: 4,
  TAN: 5,
  ASIN: 6,
  ACOS: 7,
  ATAN: 8,
  CEIL: 9,
  FLOOR: 10,
  FRAC: 11,
  ROUND: 12,
  TRUNC: 13,
} as const;

export const StdFn = {
  MIN: 0,
  MAX: 1,
  LIMIT: 2,
  FMIN: 3,
  FMAX: 4,
  FLIMIT: 5,
  SEL: 6,
  MUX: 7,
  CONCAT: 8,
  LEN: 9,
  I2S: 10,
  F2S: 11,
  B2S: 12,
  S2I: 13,
  S2F: 14,
  SASSIGN: 15,
  NORM_X: 16,
  SCALE_X: 17,
  C2S: 18,
  S2C: 19,
  DT2LDT: 20,
  LDT2DT: 21,
  DTL2LDT: 22,
  LDT2DTL: 23,
} as const;

export const SysFn = {
  LOG: 0,
  WAIT: 1,
  MILLIS: 2,
  DEVICE_OK: 3,
  CLOCK: 4,
  DEVICE_DIAG: 5,
  PN_ALARM: 6,
} as const;

export const Trap = {
  NONE: 0,
  DIV_ZERO: 1,
  BOUNDS: 2,
  STACK_OVERFLOW: 3,
  STACK_UNDERFLOW: 4,
  CALL_DEPTH: 5,
  WATCHDOG: 6,
  BAD_OPCODE: 7,
  BAD_ADDRESS: 8,
  MATH: 9,
  BAD_PROGRAM: 10,
} as const;

export const Section = {
  META: 1,
  LIMITS: 2,
  CODE: 3,
  CONST: 4,
  INIT: 5,
  FUNCS: 6,
  ENTRIES: 7,
  LINES: 8,
  IOCONF: 9,
  SYMS: 10,
  DBS: 11,
  SERVICES: 12,
} as const;

export const IoModule = {
  MODBUS_TCP: 1,
  GPIO_DI: 2,
  GPIO_DO: 3,
  GPIO_AI: 4,
  GPIO_AO: 5,
  IOLINK_MASTER: 6,
  PROFINET_DEVICE: 7,
  PROFINET_REMOTE: 8,
} as const;

export const Command = {
  INFO: 1,
  STATE: 2,
  STOP: 3,
  START: 4,
  DOWNLOAD_BEGIN: 5,
  DOWNLOAD_CHUNK: 6,
  DOWNLOAD_END: 7,
  READ: 8,
  WRITE: 9,
  FORCE: 10,
  UNFORCE_ALL: 11,
  LOGS: 12,
  UPLOAD: 13,
  AUTH: 14,
} as const;

export const Status = {
  OK: 0,
  ERROR: 1,
  BAD_REQUEST: 2,
  BAD_STATE: 3,
  BAD_CHECKSUM: 4,
  TOO_LARGE: 5,
  UNAUTHORIZED: 6,
} as const;

export const CpuState = {
  NO_PROGRAM: 0,
  STOP: 1,
  RUN: 2,
  FAULT: 3,
} as const;

export interface LibraryBlockSpec {
  code: number;
  size: number;
  members: Record<string, [string, number]>;
  hidden: Record<string, [string, number]>;
  init?: Record<string, number>;
}

export const LIBRARY_BLOCKS: Record<string, LibraryBlockSpec> = {
  "TON": {
    "code": 0,
    "size": 15,
    "members": {
      "IN": [
        "BOOL",
        0
      ],
      "Q": [
        "BOOL",
        1
      ],
      "PT": [
        "I32",
        2
      ],
      "ET": [
        "I32",
        6
      ]
    },
    "hidden": {
      "start": [
        "U32",
        10
      ],
      "flags": [
        "U8",
        14
      ]
    }
  },
  "TOF": {
    "code": 1,
    "size": 15,
    "members": {
      "IN": [
        "BOOL",
        0
      ],
      "Q": [
        "BOOL",
        1
      ],
      "PT": [
        "I32",
        2
      ],
      "ET": [
        "I32",
        6
      ]
    },
    "hidden": {
      "start": [
        "U32",
        10
      ],
      "flags": [
        "U8",
        14
      ]
    }
  },
  "TP": {
    "code": 2,
    "size": 15,
    "members": {
      "IN": [
        "BOOL",
        0
      ],
      "Q": [
        "BOOL",
        1
      ],
      "PT": [
        "I32",
        2
      ],
      "ET": [
        "I32",
        6
      ]
    },
    "hidden": {
      "start": [
        "U32",
        10
      ],
      "flags": [
        "U8",
        14
      ]
    }
  },
  "R_TRIG": {
    "code": 3,
    "size": 3,
    "members": {
      "CLK": [
        "BOOL",
        0
      ],
      "Q": [
        "BOOL",
        1
      ]
    },
    "hidden": {
      "mem": [
        "U8",
        2
      ]
    }
  },
  "F_TRIG": {
    "code": 4,
    "size": 3,
    "members": {
      "CLK": [
        "BOOL",
        0
      ],
      "Q": [
        "BOOL",
        1
      ]
    },
    "hidden": {
      "mem": [
        "U8",
        2
      ]
    },
    "init": {
      "2": 1
    }
  },
  "CTU": {
    "code": 5,
    "size": 8,
    "members": {
      "CU": [
        "BOOL",
        0
      ],
      "R": [
        "BOOL",
        1
      ],
      "Q": [
        "BOOL",
        2
      ],
      "PV": [
        "I16",
        3
      ],
      "CV": [
        "I16",
        5
      ]
    },
    "hidden": {
      "last": [
        "U8",
        7
      ]
    }
  },
  "CTD": {
    "code": 6,
    "size": 8,
    "members": {
      "CD": [
        "BOOL",
        0
      ],
      "LD": [
        "BOOL",
        1
      ],
      "Q": [
        "BOOL",
        2
      ],
      "PV": [
        "I16",
        3
      ],
      "CV": [
        "I16",
        5
      ]
    },
    "hidden": {
      "last": [
        "U8",
        7
      ]
    }
  },
  "CTUD": {
    "code": 7,
    "size": 12,
    "members": {
      "CU": [
        "BOOL",
        0
      ],
      "CD": [
        "BOOL",
        1
      ],
      "R": [
        "BOOL",
        2
      ],
      "LD": [
        "BOOL",
        3
      ],
      "QU": [
        "BOOL",
        4
      ],
      "QD": [
        "BOOL",
        5
      ],
      "PV": [
        "I16",
        6
      ],
      "CV": [
        "I16",
        8
      ]
    },
    "hidden": {
      "lastU": [
        "U8",
        10
      ],
      "lastD": [
        "U8",
        11
      ]
    }
  }
};
