// Linux network access for PROFINET (see pn_net.h).
#include "pn_net.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/if_packet.h>
#include <net/ethernet.h>
#include <net/if.h>
#include <net/route.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

namespace vplc {
namespace pn {

bool hasCapability(int cap) {
    FILE* f = fopen("/proc/self/status", "r");
    if (!f) return false;
    char line[256];
    unsigned long long eff = 0;
    while (fgets(line, sizeof line, f))
        if (sscanf(line, "CapEff: %llx", &eff) == 1) break;
    fclose(f);
    return (eff >> cap) & 1;
}

std::string capabilityHint() {
    char exe[512] = {0};
    ssize_t n = readlink("/proc/self/exe", exe, sizeof exe - 1);
    std::string path = n > 0 ? std::string(exe, size_t(n)) : "/usr/local/bin/vplc-cpu";
    return "sudo setcap cap_net_raw,cap_net_admin,cap_net_bind_service,cap_sys_nice+ep " + path + " (or the capabilities of deploy/vplc-cpu.service)";
}

uint64_t nowUs() {
    timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return uint64_t(ts.tv_sec) * 1000000u + uint64_t(ts.tv_nsec) / 1000u;
}

bool RawSocket::open(const std::string& ifname, std::string& error) {
    close();
    fd_ = socket(AF_PACKET, SOCK_RAW | SOCK_NONBLOCK | SOCK_CLOEXEC, htons(ETH_P_ALL));
    if (fd_ < 0) {
        error = std::string("raw Ethernet access refused: ") + strerror(errno) + (errno == EPERM ? " — give the CPU the network capabilities: " + capabilityHint() : "");
        return false;
    }
    ifreq ifr{};
    snprintf(ifr.ifr_name, sizeof(ifr.ifr_name), "%s", ifname.c_str());
    if (ioctl(fd_, SIOCGIFINDEX, &ifr) < 0) {
        error = "interface " + ifname + ": " + strerror(errno);
        close();
        return false;
    }
    ifindex_ = ifr.ifr_ifindex;
    if (ioctl(fd_, SIOCGIFHWADDR, &ifr) < 0) {
        error = "interface " + ifname + ": no MAC address";
        close();
        return false;
    }
    memcpy(mac_.data(), ifr.ifr_hwaddr.sa_data, 6);
    sockaddr_ll sll{};
    sll.sll_family = AF_PACKET;
    sll.sll_protocol = htons(ETH_P_ALL);
    sll.sll_ifindex = ifindex_;
    if (bind(fd_, reinterpret_cast<sockaddr*>(&sll), sizeof(sll)) < 0) {
        error = std::string("bind ") + ifname + ": " + strerror(errno);
        close();
        return false;
    }
    // DCP identify multicast address
    packet_mreq mr{};
    mr.mr_ifindex = ifindex_;
    mr.mr_type = PACKET_MR_MULTICAST;
    mr.mr_alen = 6;
    memcpy(mr.mr_address, DCP_IDENTIFY_MULTICAST.data(), 6);
    setsockopt(fd_, SOL_PACKET, PACKET_ADD_MEMBERSHIP, &mr, sizeof(mr));
    static const uint8_t lldp[6] = {0x01, 0x80, 0xC2, 0x00, 0x00, 0x0E};
    memcpy(mr.mr_address, lldp, 6);
    setsockopt(fd_, SOL_PACKET, PACKET_ADD_MEMBERSHIP, &mr, sizeof(mr));
    return true;
}

void RawSocket::close() {
    if (fd_ >= 0) ::close(fd_);
    fd_ = -1;
}

bool RawSocket::send(const std::vector<uint8_t>& frame) {
    if (fd_ < 0) return false;
    sockaddr_ll sll{};
    sll.sll_family = AF_PACKET;
    sll.sll_ifindex = ifindex_;
    sll.sll_halen = 6;
    memcpy(sll.sll_addr, frame.data(), 6);
    return sendto(fd_, frame.data(), frame.size(), 0, reinterpret_cast<sockaddr*>(&sll), sizeof(sll)) == ssize_t(frame.size());
}

size_t RawSocket::receive(uint8_t* buf, size_t capacity) {
    for (;;) {
        sockaddr_ll from{};
        socklen_t len = sizeof(from);
        ssize_t n = recvfrom(fd_, buf, capacity, 0, reinterpret_cast<sockaddr*>(&from), &len);
        if (n <= 0) return 0;
        if (from.sll_pkttype == PACKET_OUTGOING) continue;
        return size_t(n);
    }
}

bool UdpSocket::open(uint16_t port, std::string& error) {
    close();
    fd_ = socket(AF_INET, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd_ < 0) {
        error = std::string("UDP socket: ") + strerror(errno);
        return false;
    }
    int one = 1;
    setsockopt(fd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons(port);
    a.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(fd_, reinterpret_cast<sockaddr*>(&a), sizeof(a)) < 0) {
        error = "UDP port " + std::to_string(port) + ": " + strerror(errno);
        close();
        return false;
    }
    return true;
}

void UdpSocket::close() {
    if (fd_ >= 0) ::close(fd_);
    fd_ = -1;
}

bool UdpSocket::sendTo(const std::vector<uint8_t>& data, const sockaddr_in& to) {
    return fd_ >= 0 && sendto(fd_, data.data(), data.size(), 0, reinterpret_cast<const sockaddr*>(&to), sizeof(to)) == ssize_t(data.size());
}

size_t UdpSocket::receive(uint8_t* buf, size_t capacity, sockaddr_in& from) {
    socklen_t len = sizeof(from);
    ssize_t n = recvfrom(fd_, buf, capacity, 0, reinterpret_cast<sockaddr*>(&from), &len);
    return n > 0 ? size_t(n) : 0;
}

std::string ipText(uint32_t ip) {
    char s[16];
    snprintf(s, sizeof(s), "%u.%u.%u.%u", ip >> 24, (ip >> 16) & 255, (ip >> 8) & 255, ip & 255);
    return s;
}

bool parseIp(const std::string& text, uint32_t& ip) {
    in_addr a{};
    if (inet_pton(AF_INET, text.c_str(), &a) != 1) return false;
    ip = ntohl(a.s_addr);
    return true;
}

static uint32_t ifaceAddr(int fd, const std::string& ifname, unsigned long request) {
    ifreq ifr{};
    snprintf(ifr.ifr_name, sizeof(ifr.ifr_name), "%s", ifname.c_str());
    if (ioctl(fd, request, &ifr) < 0) return 0;
    return ntohl(reinterpret_cast<sockaddr_in*>(&ifr.ifr_addr)->sin_addr.s_addr);
}

Ipv4 interfaceIp(const std::string& ifname) {
    Ipv4 r;
    int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return r;
    r.ip = ifaceAddr(fd, ifname, SIOCGIFADDR);
    r.mask = ifaceAddr(fd, ifname, SIOCGIFNETMASK);
    ::close(fd);
    // default gateway through this interface (/proc/net/route: hex, little endian)
    if (FILE* f = fopen("/proc/net/route", "r")) {
        char line[256], name[64];
        unsigned dest, gw, flags;
        while (fgets(line, sizeof(line), f)) {
            if (sscanf(line, "%63s %x %x %x", name, &dest, &gw, &flags) == 4 && ifname == name && dest == 0 && (flags & RTF_GATEWAY)) {
                r.gateway = ntohl(gw);
                break;
            }
        }
        fclose(f);
    }
    return r;
}

bool setInterfaceIp(const std::string& ifname, const Ipv4& ip, std::string& error) {
    int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (fd < 0) {
        error = strerror(errno);
        return false;
    }
    auto set = [&](unsigned long request, uint32_t value) {
        ifreq ifr{};
        snprintf(ifr.ifr_name, sizeof(ifr.ifr_name), "%s", ifname.c_str());
        sockaddr_in* a = reinterpret_cast<sockaddr_in*>(&ifr.ifr_addr);
        a->sin_family = AF_INET;
        a->sin_addr.s_addr = htonl(value);
        return ioctl(fd, request, &ifr) == 0;
    };
    bool ok = set(SIOCSIFADDR, ip.ip) && (ip.ip == 0 || set(SIOCSIFNETMASK, ip.mask));
    if (!ok) error = std::string("cannot set the address of ") + ifname + ": " + strerror(errno) + (errno == EPERM ? " (CAP_NET_ADMIN needed)" : "");
    if (ok && ip.gateway && ip.gateway != ip.ip) {
        rtentry rt{};
        auto addr = [](sockaddr* s, uint32_t v) {
            sockaddr_in* a = reinterpret_cast<sockaddr_in*>(s);
            a->sin_family = AF_INET;
            a->sin_addr.s_addr = htonl(v);
        };
        addr(&rt.rt_dst, 0);
        addr(&rt.rt_genmask, 0);
        addr(&rt.rt_gateway, ip.gateway);
        rt.rt_flags = RTF_UP | RTF_GATEWAY;
        char dev[IFNAMSIZ];
        snprintf(dev, sizeof(dev), "%s", ifname.c_str());
        rt.rt_dev = dev;
        ioctl(fd, SIOCDELRT, &rt);
        if (ioctl(fd, SIOCADDRT, &rt) < 0 && errno != EEXIST) error = std::string("default route: ") + strerror(errno);
    }
    ::close(fd);
    return ok;
}

}  // namespace pn
}  // namespace vplc
