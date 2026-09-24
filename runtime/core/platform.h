// Interface between the portable CPU core and a hardware platform
// (Linux, ESP32, Arduino...).
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "program.h"
#include "vm.h"

namespace vplc {

class Platform : public VmHost {
public:
    // "linux", "esp32", "arduino-mega", ...
    virtual const char* deviceType() = 0;
    virtual uint32_t micros() = 0;

    // Non-volatile storage of the program image
    virtual bool storeProgram(const uint8_t* image, size_t length) = 0;
    // Loads the stored image into buf; returns its length (0 = none).
    virtual size_t loadProgram(uint8_t* buf, size_t capacity) = 0;

    // I/O modules of a newly loaded program (IOCONF section). Returns the number
    // of modules; unsupported modules are reported through log().
    virtual uint16_t configureIo(const Program& program) = 0;
    // Called at the start of each scan: fill the %I image.
    virtual void readInputs(uint8_t* image, uint32_t size) = 0;
    // Called at the end of each scan (and with an all-zero image in STOP/FAULT).
    virtual void writeOutputs(const uint8_t* image, uint32_t size) = 0;
};

}  // namespace vplc
