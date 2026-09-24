// LLDP (IEEE 802.1AB) with the PROFINET TLVs: announces the station (chassis ID = name of
// station, port ID "port-001") and records the neighbour seen on the interface, used by
// controllers for the topology and device replacement.
#pragma once
#include <stdint.h>

#include <functional>
#include <mutex>
#include <string>

#include "pn_stack.h"

namespace vplc {
namespace pn {

class Lldp : public Role {
public:
    /** name(): current name of station; ip(): current IPv4 address (host order) */
    Lldp(std::function<std::string()> name, std::function<uint32_t()> ip, std::function<void(const std::string&)> log)
        : name_(std::move(name)), ip_(std::move(ip)), log_(std::move(log)) {}
    void attach(Stack& stack) {
        stack_ = &stack;
        stack.add(this);
    }
    /** "name / port" of the neighbour, empty when none was seen */
    std::string neighbour();

    void onFrame(const uint8_t* p, size_t n) override;
    bool onRpc(const uint8_t*, size_t, const sockaddr_in&) override { return false; }
    uint64_t tick(uint64_t now) override;

private:
    void send();
    std::function<std::string()> name_;
    std::function<uint32_t()> ip_;
    std::function<void(const std::string&)> log_;
    Stack* stack_ = nullptr;
    uint64_t next_ = 0, neighbourSeen_ = 0;
    uint16_t neighbourTtl_ = 0;
    std::mutex mutex_;
    std::string neighbour_;
};

/** Builds an LLDP frame (exposed for tests) */
void writeLldp(std::vector<uint8_t>& out, const Mac& src, const std::string& chassis, const std::string& port, uint32_t ip, uint16_t ttl);

}  // namespace pn
}  // namespace vplc
