// Framing of the VirtualPLC device protocol (see docs/protocol.md).
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "config.h"

namespace vplc {

// Incremental parser: feed it bytes from TCP or serial.
class FrameParser {
public:
    enum Result : uint8_t { NEED_MORE, FRAME, ERROR };

    Result feed(uint8_t byte);
    void reset() { state_ = 0; pos_ = 0; }

    uint8_t command() const { return header_[2]; }
    uint8_t sequence() const { return header_[3]; }
    const uint8_t* payload() const { return payload_; }
    uint32_t length() const { return length_; }
    const char* error() const { return error_; }

private:
    uint8_t state_ = 0;  // 0 = header, 1 = payload, 2 = crc
    uint32_t pos_ = 0;
    uint8_t header_[8];
    uint32_t length_ = 0;
    uint8_t crc_[4];
    uint8_t payload_[VPLC_MAX_PAYLOAD];
    const char* error_ = "";
};

// Appends text to a fixed buffer; never overflows.
class JsonWriter {
public:
    JsonWriter(char* buf, size_t cap) : buf_(buf), cap_(cap) { buf_[0] = 0; }
    JsonWriter& raw(const char* s);
    JsonWriter& str(const char* s);      // quoted and escaped
    JsonWriter& num(int64_t v);
    JsonWriter& key(const char* k);      // "k":  (adds a comma when needed)
    JsonWriter& open(char c);            // { or [
    JsonWriter& close(char c);           // } or ]
    size_t length() const { return len_; }
    bool overflow() const { return overflow_; }

private:
    void put(char c);
    void comma();
    void quoted(const char* s);
    char* buf_;
    size_t cap_;
    size_t len_ = 0;
    bool first_ = true;
    bool overflow_ = false;
};

// Writes a response frame header + payload + CRC into out (capacity >= payloadLen + 13).
size_t encodeResponse(uint8_t* out, uint8_t command, uint8_t sequence, uint8_t status, const uint8_t* payload, uint32_t payloadLen);

}  // namespace vplc
