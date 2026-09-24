#include "bytes.h"

namespace vplc {

// Bitwise CRC-32 (IEEE): no 1 KiB table, which matters on small MCUs.
uint32_t crc32(const uint8_t* data, uint32_t len, uint32_t crc) {
    crc = ~crc;
    for (uint32_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int k = 0; k < 8; k++) crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
    }
    return ~crc;
}

}  // namespace vplc
