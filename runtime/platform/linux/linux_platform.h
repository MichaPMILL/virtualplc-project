// Linux / Raspberry Pi platform: files for storage, Modbus TCP remote I/O,
// GPIO through the kernel GPIO character device (/dev/gpiochipN).
#pragma once
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "cpu.h"
#include "datalog/datalog.h"
#include "modbus.h"
#include "profinet/pn_controller.h"
#include "profinet/pn_device.h"
#include "profinet/pn_lldp.h"
#include "profinet/pn_stack.h"
#include "security/security.h"

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
    bool moduleDiag(uint16_t index) override;
    size_t moduleDiagnostics(uint16_t index, char* out, size_t cap) override;
    bool alarm(uint16_t module, uint16_t slot, uint16_t kind, uint32_t code) override;
    bool clock(bool local, int64_t& ns) override;
    bool storeProgram(const uint8_t* image, size_t length) override;
    size_t loadProgram(uint8_t* buf, size_t capacity) override;
    uint16_t configureIo(const Program& program) override;
    void readInputs(uint8_t* image, uint32_t size) override;
    void writeOutputs(const uint8_t* image, uint32_t size) override;
    void drainMessages(void (*record)(void* ctx, const char* message), void* ctx) override;
    bool configureDataLogs(const Program& program) override;
    bool dataLog(uint16_t log, int64_t timeNs, const uint8_t* values, uint32_t length) override;
    size_t dataLogRead(uint16_t log, uint16_t count, uint64_t before, bool full, char* out, size_t cap) override;
    size_t dataLogTest(uint16_t log, char* out, size_t cap) override;
    const char* setSecret(const char* key, const char* value) override;
    bool hasUsers() override;
    uint8_t authenticate(const char* user, const char* password) override;
    const char* users(const uint8_t* request, uint32_t length, const char* user, uint8_t role, char* out, size_t cap, size_t& written) override;
    void audit(const char* user, const char* peer, const char* action, const char* detail) override;
    size_t auditRead(uint32_t from, uint16_t count, char* out, size_t cap) override;
    sec::Security& security() { return security_; }
    /** Name of the CPU (recorded with the traceability records) */
    void setPlcName(const std::string& name) {
        plcName_ = name;
        security_.setPlcName(name);
    }

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
    /** Prints a message and keeps it for the diagnostic buffer (any thread) */
    void note(const std::string& message);
    std::mutex notesMutex_;
    std::vector<std::string> notes_;

    std::string dataDir_;
    std::string gpioChip_;
    std::string plcName_ = "PLC_1";
    sec::Security security_{dataDir_};
    std::string usersError_;
    std::unique_ptr<DataLogger> dataLogger_;
    std::vector<Module> modules_;
    // PROFINET: this CPU as IO-Device, and / or IO-Controller of remote devices
    std::unique_ptr<pn::Device> pnDevice_;
    std::unique_ptr<pn::Controller> pnController_;
    std::string pnDeviceKey_, pnControllerKey_;
    std::vector<std::unique_ptr<pn::Lldp>> pnLldp_;
    std::string pnError_;  // why PROFINET could not start (shown in the Studio)
    std::vector<std::unique_ptr<pn::Stack>> pnStacks_;  // declared after the roles: destroyed first
    std::vector<uint16_t> pnRemoteIndex_;  // module index -> device index of the controller
};

}  // namespace vplc
