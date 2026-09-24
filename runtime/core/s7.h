// S7 communication server ("PUT/GET" access over ISO-on-TCP, RFC 1006, TCP port 102):
// lets HMIs and SCADA systems configured for an S7 connection read and write the
// process image (%I, %Q, %M) and numbered data blocks (DBn.DBX/DBB/DBW/DBD) by
// absolute address. Portable (no heap): one S7Session per TCP connection.
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "program.h"
#include "vm.h"

namespace vplc {

class S7Session {
public:
    using SendFn = bool (*)(void* ctx, const uint8_t* data, size_t length);

    struct Options {
        bool allowWrite = true;
        const char* name = "PLC_1";
    };

    // Processes received bytes and sends the responses. Returns false when the
    // connection must be closed (protocol error or disconnect request).
    bool receive(const uint8_t* data, size_t length, Vm& vm, const Program& program, const Options& options, SendFn send, void* ctx);

    uint16_t pduSize() const { return pdu_; }

private:
    bool packet(const uint8_t* p, size_t n, Vm& vm, const Program& program, const Options& options, SendFn send, void* ctx);
    size_t job(const uint8_t* s7, size_t n, Vm& vm, const Program& program, const Options& options, uint8_t* out, size_t cap);

    uint8_t in_[1024];
    size_t used_ = 0;
    uint16_t pdu_ = 240;
    bool connected_ = false;
};

// S7 area codes
enum : uint8_t { S7_AREA_I = 0x81, S7_AREA_Q = 0x82, S7_AREA_M = 0x83, S7_AREA_DB = 0x84 };

}  // namespace vplc
