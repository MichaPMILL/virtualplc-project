// Endian-safe helpers (no alignment requirements).
#pragma once
#include <stdint.h>

namespace vplc {

inline uint16_t rd16le(const uint8_t* p) { return uint16_t(p[0] | (p[1] << 8)); }
inline uint32_t rd32le(const uint8_t* p) {
    return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}
inline uint64_t rd64le(const uint8_t* p) { return uint64_t(rd32le(p)) | (uint64_t(rd32le(p + 4)) << 32); }

inline void wr16le(uint8_t* p, uint16_t v) { p[0] = uint8_t(v); p[1] = uint8_t(v >> 8); }
inline void wr32le(uint8_t* p, uint32_t v) {
    p[0] = uint8_t(v); p[1] = uint8_t(v >> 8); p[2] = uint8_t(v >> 16); p[3] = uint8_t(v >> 24);
}

// PLC memory is big-endian (as on most PLCs).
inline uint64_t rdbe(const uint8_t* p, unsigned n) {
    uint64_t v = 0;
    for (unsigned i = 0; i < n; i++) v = (v << 8) | p[i];
    return v;
}
inline void wrbe(uint8_t* p, unsigned n, uint64_t v) {
    for (int i = int(n) - 1; i >= 0; i--) { p[i] = uint8_t(v); v >>= 8; }
}

uint32_t crc32(const uint8_t* data, uint32_t len, uint32_t crc = 0);

}  // namespace vplc
