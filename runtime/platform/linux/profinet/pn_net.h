// Linux network access for PROFINET: raw Ethernet frames (AF_PACKET, needs CAP_NET_RAW),
// the RPC UDP socket and the IPv4 settings of an interface (DCP "set IP").
#pragma once
#include <netinet/in.h>
#include <stdint.h>

#include <string>
#include <vector>

#include "pn_proto.h"

namespace vplc {
namespace pn {

class RawSocket {
public:
    ~RawSocket() { close(); }
    bool open(const std::string& ifname, std::string& error);
    void close();
    int fd() const { return fd_; }
    const Mac& mac() const { return mac_; }
    bool send(const std::vector<uint8_t>& frame);
    /** Next received frame (not our own outgoing ones); 0 when none is pending. */
    size_t receive(uint8_t* buf, size_t capacity);

private:
    int fd_ = -1;
    int ifindex_ = 0;
    Mac mac_{};
};

class UdpSocket {
public:
    ~UdpSocket() { close(); }
    /** Binds to the port on all addresses (0 = ephemeral port). */
    bool open(uint16_t port, std::string& error);
    void close();
    int fd() const { return fd_; }
    bool sendTo(const std::vector<uint8_t>& data, const sockaddr_in& to);
    /** Next datagram; 0 when none is pending. */
    size_t receive(uint8_t* buf, size_t capacity, sockaddr_in& from);

private:
    int fd_ = -1;
};

struct Ipv4 {
    uint32_t ip = 0, mask = 0, gateway = 0;  // host byte order
};
std::string ipText(uint32_t ip);
bool parseIp(const std::string& text, uint32_t& ip);
/** Current address and mask of an interface (gateway: default route through it). */
Ipv4 interfaceIp(const std::string& ifname);
/** Sets address and mask (and the default route when a gateway is given); needs CAP_NET_ADMIN. */
bool setInterfaceIp(const std::string& ifname, const Ipv4& ip, std::string& error);

/** Monotonic time in microseconds */
uint64_t nowUs();

}  // namespace pn
}  // namespace vplc
