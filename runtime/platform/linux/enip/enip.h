// EtherNet/IP scanner (originator) of the Linux CPU — in-house implementation, no third-party
// stack. Encapsulation over TCP 44818 (RegisterSession, SendRRData), CIP Connection Manager
// (Forward_Open / Forward_Close) and implicit class 1 I/O over UDP 2222, cyclic at the RPI.
//
// One thread manages the connections (TCP, Forward_Open, reconnection), one thread exchanges
// the I/O (UDP). The CPU copies the process images with readInputs / writeOutputs.
#pragma once

#include <stdint.h>

#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace vplc::enip {

struct AdapterConfig {
    std::string name;
    std::string host;
    uint16_t port = 44818;
    uint32_t rpiUs = 10000;
    uint16_t configInstance = 0, outInstance = 0, inInstance = 0;
    uint16_t outLength = 0, outByte = 0, inLength = 0, inByte = 0;
    bool outHeader = true;   // O->T 32-bit run/idle header
    bool inHeader = false;   // T->O 32-bit run/idle header
    bool multicast = false;  // T->O multicast
    uint8_t timeoutMultiplier = 1;
    bool electronicKey = false;
    uint16_t vendorId = 0, deviceType = 0, productCode = 0;
    uint8_t revMajor = 0, revMinor = 0;
    std::vector<uint8_t> configData;
};

// Identity of a device (ListIdentity)
struct Identity {
    std::string address;
    uint16_t vendorId = 0, deviceType = 0, productCode = 0;
    uint8_t revMajor = 0, revMinor = 0;
    uint16_t status = 0;
    uint32_t serial = 0;
    std::string productName;
};

// CIP status as text ("0x01/0x0100: connection in use or duplicate Forward_Open")
std::string cipStatusText(uint8_t general, uint16_t extended);

// Builds the Forward_Open request data (service 0x54 to the Connection Manager); exposed for tests
std::vector<uint8_t> forwardOpenData(const AdapterConfig& c, uint32_t toId, uint16_t serial, uint32_t originatorSerial);

class Scanner {
public:
    using Logger = std::function<void(const std::string&)>;
    Scanner(std::vector<AdapterConfig> adapters, Logger log, uint16_t udpPort = 2222);
    ~Scanner();

    bool start(std::string& err);

    void readInputs(uint8_t* image, uint32_t size);
    void writeOutputs(const uint8_t* image, uint32_t size, bool run);

    bool ok(size_t k) const;
    std::string status(size_t k) const;

private:
    enum class State { IDLE, CONNECTING, RUNNING, FAILED };
    struct Adapter {
        AdapterConfig cfg;
        State state = State::IDLE;
        std::string status;
        int tcp = -1;
        uint32_t session = 0;
        uint32_t otId = 0, toId = 0;  // network connection ids
        uint16_t serial = 0;
        uint32_t otApiUs = 0, toApiUs = 0;
        uint32_t ip = 0;              // network order
        uint32_t multicastGroup = 0;  // network order, 0 = point to point
        uint32_t encapSeq = 0;
        uint16_t cipSeq = 0, lastRxSeq = 0;
        bool rxSeen = false;
        uint64_t nextSendUs = 0, lastRxUs = 0, retryAtUs = 0;
        uint32_t backoffMs = 1000;
        std::vector<uint8_t> in, out;
        bool running = false;   // the CPU is in RUN (O->T run/idle header)
        bool remoteRun = true;  // T->O run/idle header of the adapter
        uint64_t packetsIn = 0, packetsOut = 0, timeouts = 0;
    };

    void manage();
    void exchange();
    bool connect(Adapter& a, std::string& err);
    void disconnect(Adapter& a, bool sendClose);
    bool request(Adapter& a, uint16_t command, const std::vector<uint8_t>& body, std::vector<uint8_t>& reply, std::string& err);
    bool cip(Adapter& a, const std::vector<uint8_t>& message, std::vector<uint8_t>& reply, std::vector<uint8_t>* items, std::string& err);
    void fail(Adapter& a, const std::string& why);

    std::vector<Adapter> adapters_;
    Logger log_;
    uint16_t udpPort_;
    int udp_ = -1;
    mutable std::mutex mutex_;
    std::atomic<bool> stop_{false};
    std::thread manager_, io_;
    uint32_t originatorSerial_ = 0;
};

// Broadcast ListIdentity on the local networks; answers collected for `timeoutMs`
std::vector<Identity> listIdentity(uint32_t timeoutMs, const std::string& target = "255.255.255.255");

}  // namespace vplc::enip
