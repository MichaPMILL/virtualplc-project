// VirtualPLC platform for microcontrollers (Arduino framework): program storage, GPIO
// modules (digital / analog inputs and outputs), clock.
#pragma once
#include <Arduino.h>

#include "board.h"
#include "cpu.h"

namespace vplc {

class McuPlatform : public Platform {
public:
    void begin();
    const char* deviceType() override { return VPLC_BOARD; }
    uint32_t millis() override { return ::millis(); }
    uint32_t micros() override { return ::micros(); }
    void log(const char* message) override;
    bool moduleOk(uint16_t index) override { return index < count_ && modules_[index].ok; }
    bool clock(bool local, int64_t& ns) override;
    bool storeProgram(const uint8_t* image, size_t length) override;
    size_t loadProgram(uint8_t* buf, size_t capacity) override;
    uint16_t configureIo(const Program& program) override;
    void readInputs(uint8_t* image, uint32_t size) override;
    void writeOutputs(const uint8_t* image, uint32_t size) override;
    void drainMessages(void (*record)(void* ctx, const char* message), void* ctx) override;

    /** Messages for the diagnostic buffer (the serial port carries the protocol) */
    void note(const char* message);

private:
    static constexpr uint16_t MAX_MODULES = 32;
    struct Module {
        uint8_t kind = 0, pin = 0, bit = 0, flags = 0;
        uint16_t byte = 0;
        bool ok = false;
    };
    Module modules_[MAX_MODULES];
    uint16_t count_ = 0;
    // pending messages (configureIo runs before the CPU can record them)
    char notes_[4][VPLC_LOG_LENGTH];
    uint8_t noteCount_ = 0;
    bool storageOk_ = false;
};

}  // namespace vplc
