// OPC UA server of the Linux CPU (open62541): exposes the variables visible to HMIs
// (SYMS section) and the CPU status, for HMIs / SCADA with an OPC UA client.
#pragma once
#include <stdint.h>

#include <string>
#include <vector>

#include "cpu.h"
#include "hmi.h"

struct UA_Server;

namespace vplc {

class OpcUaServer {
public:
    OpcUaServer(Cpu& cpu, Platform& platform);
    ~OpcUaServer();
    OpcUaServer(const OpcUaServer&) = delete;
    OpcUaServer& operator=(const OpcUaServer&) = delete;

    // User name / password accepted besides (or instead of) anonymous access.
    void setUser(const std::string& user, const std::string& password);
    // Starts, stops or restarts the server (port 0 = stopped). The address space is
    // rebuilt when the program changes.
    void configure(uint16_t port, bool allowWrite, bool anonymous, const std::string& name);
    // Processes network events (non-blocking); call from the main loop, between scans.
    void iterate();
    bool running() const { return server_ != nullptr; }

    // used by the node callbacks
    Cpu& cpu() { return cpu_; }
    const SymbolInfo* symbol(uint32_t index) const { return index < symbols_.size() ? &symbols_[index] : nullptr; }
    bool allowWrite() const { return write_; }

private:
    void start();
    void stop();
    void build();

    Cpu& cpu_;
    Platform& platform_;
    UA_Server* server_ = nullptr;
    uint16_t port_ = 0;
    bool write_ = true, anonymous_ = true;
    uint32_t programId_ = 0;
    std::string name_, user_, password_;
    std::vector<SymbolInfo> symbols_;
    uint32_t retryAt_ = 0;
};

}  // namespace vplc
