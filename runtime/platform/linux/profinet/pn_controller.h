// PROFINET IO-Controller (RT_CLASS_1): drives remote IO-Devices described by their GSDML.
//
// For each device: DCP identify by name of station, DCP set IP when it differs, RPC
// connect (AR, input / output IOCR, alarm CR, expected submodules), PrmEnd, wait for
// ApplicationReady, then cyclic exchange with a watchdog; lost devices are reconnected.
// Input data of the devices go to %I, output data come from %Q (bytes per submodule).
#pragma once
#include <stdint.h>

#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "pn_net.h"
#include "pn_proto.h"

namespace vplc {
namespace pn {

struct RemoteSubmodule {
    uint16_t slot = 0, subslot = 1;
    uint32_t moduleIdent = 0, submoduleIdent = 0;
    uint16_t inLength = 0, inByte = 0;    // device → %I
    uint16_t outLength = 0, outByte = 0;  // %Q → device
};

struct RemoteDevice {
    std::string stationName;
    std::string ip;
    uint16_t vendorId = 0, deviceId = 0;
    uint16_t cycleMs = 8, watchdog = 3;
    std::vector<RemoteSubmodule> submodules;
};

struct ControllerConfig {
    std::string ifname = "eth0";
    std::string stationName = "plc";  // our name (sent in the connect request)
    std::vector<RemoteDevice> devices;
    std::function<void(const std::string&)> log;
};

class Controller {
public:
    explicit Controller(ControllerConfig config);
    ~Controller();
    bool start(std::string& error);
    void stop();
    bool running() const { return thread_.joinable(); }

    /** Device inputs → process image (called before each scan) */
    void readInputs(uint8_t* image, uint32_t size);
    /** Process image → device outputs (called after each scan) */
    void writeOutputs(const uint8_t* image, uint32_t size, bool run);
    /** True when the device (index in the configuration) exchanges data */
    bool deviceOk(size_t index) const;
    std::string status(size_t index) const;

private:
    enum State { S_IDENTIFY, S_WAIT_IDENTIFY, S_WAIT_SET_IP, S_WAIT_CONNECT, S_WAIT_PRMEND, S_WAIT_APPREADY, S_RUN, S_PAUSE };
    struct Dev {
        RemoteDevice cfg;
        std::atomic<int> state{S_IDENTIFY};
        uint32_t ip = 0;
        Mac mac{};
        uint32_t xid = 0;
        uint64_t deadline = 0, lastRx = 0, nextSend = 0;
        int tries = 0;
        ArInfo ar;
        IocrInfo in, out;  // input CR (we receive), output CR (we send)
        uint16_t inFrameId = 0, outFrameId = 0;
        uint16_t cycleCounter = 0;
        Uuid activity;
        uint32_t sequence = 0;
        std::vector<uint8_t> request;  // last RPC request (retransmission)
        struct Layout { uint16_t inOffset, inIops, outOffset, outIops; bool hasOut; };
        std::vector<Layout> layout;    // per submodule
        std::vector<uint8_t> inputs;   // latest input data, per submodule concatenated (inLength)
        std::string status = "starting";
    };

    void loop();
    void log(const std::string& text);
    void step(Dev& d, uint64_t now);
    void identify(Dev& d);
    void setIp(Dev& d);
    void connect(Dev& d);
    void prmEnd(Dev& d);
    void sendRequest(Dev& d, uint16_t opnum);
    void sendCyclic(Dev& d);
    void lost(Dev& d, const std::string& why, bool pause = true);
    void onFrame(const uint8_t* p, size_t n);
    void onRpc(const uint8_t* p, size_t n, const sockaddr_in& from);
    void onRpcResponse(Dev& d, const RpcHeader& h, const uint8_t* body);
    void onAppReady(const RpcHeader& h, const uint8_t* body, const sockaddr_in& from);

    ControllerConfig config_;
    RawSocket raw_;
    UdpSocket rpc_;
    std::thread thread_;
    std::atomic<bool> stop_{false};
    int wake_ = -1;
    Uuid object_;
    uint16_t sessionKey_ = 0;
    std::vector<std::unique_ptr<Dev>> devs_;
    mutable std::mutex ioMutex_;
    std::vector<uint8_t> outputs_;  // copy of the %Q image
    uint32_t outputsSize_ = 0;
    bool plcRun_ = false;
    uint64_t lastWrite_ = 0;  // outputs older than 500 ms: the CPU is not running
    std::vector<uint8_t> frame_;
};

}  // namespace pn
}  // namespace vplc
