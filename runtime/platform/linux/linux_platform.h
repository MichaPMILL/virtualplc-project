// Linux / Raspberry Pi platform: files for storage, Modbus TCP remote I/O,
// GPIO through the kernel GPIO character device (/dev/gpiochipN).
#pragma once
#include <memory>
#include <string>
#include <vector>

#include "cpu.h"
#include "modbus.h"
#include "profinet/pn_controller.h"
#include "profinet/pn_device.h"

namespace vplc {

class LinuxPlatform : public Platform {
public:
    LinuxPlatform(std::string dataDir, std::string gpioChip);
    ~LinuxPlatform() override;

    const char* deviceType() override;
    uint32_t millis() override;
    uint32_t micros() override;
    void log(const char* message) override;
    bool moduleOk(uint16_t index) override;
    bool clock(bool local, int64_t& ns) override;
    bool storeProgram(const uint8_t* image, size_t length) override;
    size_t loadProgram(uint8_t* buf, size_t capacity) override;
    uint16_t configureIo(const Program& program) override;
    void readInputs(uint8_t* image, uint32_t size) override;
    void writeOutputs(const uint8_t* image, uint32_t size) override;

private:
    struct Module {
        IoModuleInfo info;
        std::unique_ptr<ModbusClient> modbus;
        int gpioFd = -1;
        bool ok = false;
        bool supported = true;
        uint32_t nextPoll = 0;
        uint32_t retryAt = 0;
        uint32_t backoff = 1000;
        std::vector<uint8_t> lastCoils;   // last written coil image (to write only on change)
        std::vector<uint16_t> lastRegs;
        uint32_t lastWrite = 0;
    };

    void closeModules();
    void failed(Module& m, const std::string& what);
    bool openGpio(Module& m, bool output);

    void configureProfinet();

    std::string dataDir_;
    std::string gpioChip_;
    std::vector<Module> modules_;
    // PROFINET: this CPU as IO-Device, and / or IO-Controller of remote devices
    std::unique_ptr<pn::Device> pnDevice_;
    std::unique_ptr<pn::Controller> pnController_;
    std::string pnDeviceKey_, pnControllerKey_;
    std::vector<uint16_t> pnRemoteIndex_;  // module index -> device index of the controller
};

}  // namespace vplc
