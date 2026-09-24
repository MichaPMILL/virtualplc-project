#include "protocol.h"

#include <stdio.h>
#include <string.h>

#include "bytes.h"

namespace vplc {

FrameParser::Result FrameParser::feed(uint8_t b) {
    switch (state_) {
        case 0:
            header_[pos_++] = b;
            if (pos_ == 1 && b != 'V') { pos_ = 0; error_ = "bad magic"; return ERROR; }
            if (pos_ == 2 && b != 'P') { pos_ = 0; error_ = "bad magic"; return ERROR; }
            if (pos_ == 8) {
                length_ = rd32le(header_ + 4);
                if (length_ > VPLC_MAX_PAYLOAD) { reset(); error_ = "payload too large"; return ERROR; }
                pos_ = 0;
                state_ = length_ ? 1 : 2;
            }
            return NEED_MORE;
        case 1:
            payload_[pos_++] = b;
            if (pos_ == length_) { pos_ = 0; state_ = 2; }
            return NEED_MORE;
        default: {
            crc_[pos_++] = b;
            if (pos_ < 4) return NEED_MORE;
            state_ = 0;
            pos_ = 0;
            uint32_t crc = crc32(header_ + 2, 6);
            crc = crc32(payload_, length_, crc);
            if (crc != rd32le(crc_)) { error_ = "bad checksum"; return ERROR; }
            return FRAME;
        }
    }
}

size_t encodeResponse(uint8_t* out, uint8_t command, uint8_t sequence, uint8_t status, const uint8_t* payload, uint32_t len) {
    out[0] = 'V';
    out[1] = 'R';
    out[2] = command;
    out[3] = sequence;
    out[4] = status;
    wr32le(out + 5, len);
    if (len && payload != out + 9) memmove(out + 9, payload, len);
    uint32_t crc = crc32(out + 2, 7 + len);
    wr32le(out + 9 + len, crc);
    return 13 + len;
}

void JsonWriter::put(char c) {
    if (len_ + 1 < cap_) {
        buf_[len_++] = c;
        buf_[len_] = 0;
    } else {
        overflow_ = true;
    }
}

void JsonWriter::comma() {
    if (!first_) put(',');
    first_ = false;
}

void JsonWriter::quoted(const char* s) {
    put('"');
    for (; *s; s++) {
        unsigned char c = static_cast<unsigned char>(*s);
        if (c == '"' || c == '\\') { put('\\'); put(char(c)); }
        else if (c == '\n') { put('\\'); put('n'); }
        else if (c < 0x20) {
            char esc[8];
            snprintf(esc, sizeof esc, "\\u%04x", c);
            for (char* e = esc; *e; e++) put(*e);
        } else put(char(c));
    }
    put('"');
}

// Every value (and every key) is preceded by a comma unless it is the first
// element of an object/array or the value of a key.
JsonWriter& JsonWriter::raw(const char* s) {
    comma();
    while (*s) put(*s++);
    return *this;
}

JsonWriter& JsonWriter::str(const char* s) {
    comma();
    quoted(s);
    return *this;
}

JsonWriter& JsonWriter::num(int64_t v) {
    char tmp[24];
    snprintf(tmp, sizeof tmp, "%lld", static_cast<long long>(v));
    return raw(tmp);
}

JsonWriter& JsonWriter::key(const char* k) {
    comma();
    quoted(k);
    put(':');
    first_ = true;
    return *this;
}

JsonWriter& JsonWriter::open(char c) {
    comma();
    put(c);
    first_ = true;
    return *this;
}

JsonWriter& JsonWriter::close(char c) {
    put(c);
    first_ = false;
    return *this;
}

}  // namespace vplc
