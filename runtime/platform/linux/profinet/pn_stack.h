// One PROFINET stack per network interface: the raw Ethernet socket, the RPC socket
// (UDP 34964) and the thread that serves the roles attached to it (IO-Device and / or
// IO-Controller on the same interface).
#pragma once
#include <netinet/in.h>
#include <stdint.h>

#include <atomic>
#include <functional>
#include <string>
#include <thread>
#include <vector>

#include "pn_net.h"

namespace vplc {
namespace pn {

class Stack;

/** A PROFINET role served by a stack; all calls come from the stack thread. */
class Role {
public:
    virtual ~Role() = default;
    /** Ethernet frame received on the interface (whole frame) */
    virtual void onFrame(const uint8_t* p, size_t n) = 0;
    /** RPC datagram; returns true when the role handled it */
    virtual bool onRpc(const uint8_t* p, size_t n, const sockaddr_in& from) = 0;
    /** Timers and cyclic sending; returns the next time (µs, nowUs()) it wants to run */
    virtual uint64_t tick(uint64_t now) = 0;
    /** Called on the stack thread when it stops (orderly release of connections) */
    virtual void onStop() {}
};

class Stack {
public:
    Stack(std::string ifname, std::function<void(const std::string&)> log) : ifname_(std::move(ifname)), log_(std::move(log)) {}
    ~Stack() { stop(); }
    bool open(std::string& error);
    /** Roles are attached before start() and must outlive the stack thread. */
    void add(Role* role) { roles_.push_back(role); }
    void start();
    void stop();
    bool running() const { return thread_.joinable(); }
    const std::string& ifname() const { return ifname_; }
    RawSocket& raw() { return raw_; }
    UdpSocket& rpc() { return rpc_; }
    void log(const std::string& text) const {
        if (log_) log_(text);
    }

private:
    void loop();
    std::string ifname_;
    std::function<void(const std::string&)> log_;
    RawSocket raw_;
    UdpSocket rpc_;
    std::vector<Role*> roles_;
    std::thread thread_;
    std::atomic<bool> stop_{false};
    int wake_ = -1;
};

}  // namespace pn
}  // namespace vplc
