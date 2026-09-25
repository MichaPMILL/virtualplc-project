// PROFIBUS DP master (class 1, DP-V0) of the Linux CPU, through an RS-485 adapter (USB or
// serial port): in-house implementation of the FDL telegrams (SD1, SD2, short acknowledgement)
// and of the DP services Slave_Diag, Set_Prm, Chk_Cfg and Data_Exchange.
//
// Single master on its bus (no token passing): the master polls each slave in turn. The bus
// speed is set with termios2 (any speed the adapter accepts: 9.6 kbit/s … 12 Mbit/s); the
// characters are 8 data bits, even parity, 1 stop bit as required by PROFIBUS.
#pragma once

#include <stdint.h>

#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace vplc::dp {

struct SlaveConfig {
    std::string name;
    uint8_t station = 3;
    uint16_t identNumber = 0;
    uint16_t watchdogMs = 0;
    std::vector<uint8_t> userPrm;
    std::vector<uint8_t> config;
    uint16_t inByte = 0, inLength = 0, outByte = 0, outLength = 0;
};

struct BusConfig {
    std::string port;
    uint32_t baud = 500000;
    uint8_t masterAddress = 1;
    bool echo = false;          // the adapter receives its own transmission
    uint32_t replyTimeoutMs = 0;  // 0: from the speed
    std::vector<SlaveConfig> slaves;
};

// FDL frame helpers (exposed for the tests)
std::vector<uint8_t> sd1(uint8_t da, uint8_t sa, uint8_t fc);
std::vector<uint8_t> sd2(uint8_t da, uint8_t sa, uint8_t fc, const std::vector<uint8_t>& data, int dsap = -1, int ssap = -1);
// Input / output lengths described by configuration identifiers (compact and special formats)
void configLengths(const std::vector<uint8_t>& cfg, uint16_t& in, uint16_t& out);
std::string diagText(const std::vector<uint8_t>& diag);

class Master {
public:
    using Logger = std::function<void(const std::string&)>;
    Master(BusConfig cfg, Logger log);
    ~Master();
    bool start(std::string& err);

    void readInputs(uint8_t* image, uint32_t size);
    void writeOutputs(const uint8_t* image, uint32_t size);

    bool ok(size_t k) const;
    bool diag(size_t k) const;  // extended diagnosis reported by the slave
    std::string status(size_t k) const;

private:
    enum class State { DIAG, PRM, CFG, CHECK, DATA, OFFLINE };
    struct Slave {
        SlaveConfig cfg;
        State state = State::DIAG;
        bool fcb = true;         // next frame count bit
        bool fcv = false;        // frame count valid (after the first frame)
        std::vector<uint8_t> in, out, lastDiag;
        bool running = false;    // data exchange
        bool extDiag = false;
        bool wantDiag = false;   // the slave answered "high priority": read its diagnosis
        uint32_t errors = 0, lost = 0, cycles = 0;
        uint64_t retryAtUs = 0;
        std::string status = "not connected";
    };

    void run();
    bool transact(Slave& s, const std::vector<uint8_t>& frame, std::vector<uint8_t>& reply, bool& shortAck, uint8_t& fc);
    bool readFrame(std::vector<uint8_t>& frame, uint32_t timeoutMs);
    bool poll(Slave& s);
    uint8_t nextFc(Slave& s);
    void failSlave(Slave& s, const std::string& why);

    BusConfig bus_;
    Logger log_;
    int fd_ = -1;
    std::vector<Slave> slaves_;
    mutable std::mutex mutex_;
    std::atomic<bool> stop_{false};
    std::thread thread_;
    uint64_t cycleUs_ = 0;
};

}  // namespace vplc::dp
