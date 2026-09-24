// LLDP with PROFINET TLVs (see pn_lldp.h).
#include "pn_lldp.h"

#include <stdio.h>
#include <string.h>

namespace vplc {
namespace pn {

namespace {
const Mac LLDP_MULTICAST = {0x01, 0x80, 0xC2, 0x00, 0x00, 0x0E};
const uint8_t OUI_PROFINET[3] = {0x00, 0x0E, 0xCF};
const uint8_t OUI_IEEE_8023[3] = {0x00, 0x12, 0x0F};
constexpr uint16_t TTL_S = 20;
constexpr uint64_t PERIOD_US = 5000000;

void tlv(Writer& w, uint8_t type, const uint8_t* data, size_t n) {
    w.u16(uint16_t((type << 9) | (n & 0x1FF))).bytes(data, n);
}
}  // namespace

void writeLldp(std::vector<uint8_t>& out, const Mac& src, const std::string& chassis, const std::string& port, uint32_t ip, uint16_t ttl) {
    out.clear();
    Writer w(out);
    w.mac(LLDP_MULTICAST).mac(src).u16(ETHERTYPE_LLDP);
    std::vector<uint8_t> v;
    auto begin = [&](uint8_t first) { v.assign(1, first); };
    begin(7);  // chassis ID, locally assigned: name of station
    v.insert(v.end(), chassis.begin(), chassis.end());
    tlv(w, 1, v.data(), v.size());
    begin(7);  // port ID, locally assigned
    v.insert(v.end(), port.begin(), port.end());
    tlv(w, 2, v.data(), v.size());
    uint8_t t[2] = {uint8_t(ttl >> 8), uint8_t(ttl)};
    tlv(w, 3, t, 2);
    // PROFINET: port status (RT class 2 / 3 off), chassis MAC
    uint8_t status[8] = {OUI_PROFINET[0], OUI_PROFINET[1], OUI_PROFINET[2], 0x02, 0, 0, 0, 0};
    tlv(w, 127, status, sizeof status);
    uint8_t chassisMac[10] = {OUI_PROFINET[0], OUI_PROFINET[1], OUI_PROFINET[2], 0x05};
    memcpy(chassisMac + 4, src.data(), 6);
    tlv(w, 127, chassisMac, sizeof chassisMac);
    // IEEE 802.3 MAC / PHY: autonegotiation supported and enabled, 100BASE-TX full duplex
    uint8_t phy[9] = {OUI_IEEE_8023[0], OUI_IEEE_8023[1], OUI_IEEE_8023[2], 0x01, 0x03, 0x6C, 0x00, 0x00, 0x10};
    tlv(w, 127, phy, sizeof phy);
    if (ip) {  // management address: IPv4, interface number 1
        uint8_t m[12] = {5, 1, uint8_t(ip >> 24), uint8_t(ip >> 16), uint8_t(ip >> 8), uint8_t(ip), 2, 0, 0, 0, 1, 0};
        tlv(w, 8, m, sizeof m);
    }
    w.u16(0);  // end of LLDPDU
    while (out.size() < 60) out.push_back(0);
}

void Lldp::send() {
    std::string name = name_ ? name_() : std::string();
    if (name.empty()) name = macText(stack_->raw().mac());
    std::vector<uint8_t> f;
    writeLldp(f, stack_->raw().mac(), name, "port-001", ip_ ? ip_() : 0, TTL_S);
    stack_->raw().send(f);
}

uint64_t Lldp::tick(uint64_t now) {
    if (now >= next_) {
        send();
        next_ = now + PERIOD_US;
    }
    if (neighbourSeen_ && now - neighbourSeen_ > uint64_t(neighbourTtl_ ? neighbourTtl_ : TTL_S) * 1000000u) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (log_) log_("PROFINET: neighbour " + neighbour_ + " no longer seen on " + stack_->ifname());
        neighbour_.clear();
        neighbourSeen_ = 0;
    }
    return next_;
}

void Lldp::onFrame(const uint8_t* p, size_t n) {
    EthFrame eth;
    if (!parseEth(p, n, eth) || eth.type != ETHERTYPE_LLDP) return;
    Reader r(eth.payload, eth.length);
    std::string chassis, port;
    uint16_t ttl = 0;
    while (r.remaining() >= 2) {
        uint16_t h = r.u16();
        uint8_t type = uint8_t(h >> 9);
        uint16_t len = h & 0x1FF;
        const uint8_t* d = r.take(len);
        if (!d || type == 0) break;
        if (type == 1 && len > 1) chassis.assign(reinterpret_cast<const char*>(d + 1), len - 1u);
        if (type == 2 && len > 1) port.assign(reinterpret_cast<const char*>(d + 1), len - 1u);
        if (type == 3 && len >= 2) ttl = uint16_t((d[0] << 8) | d[1]);
    }
    if (chassis.empty()) return;
    // MAC address subtypes are binary
    auto printable = [](std::string& s) {
        for (char c : s)
            if (c < 32 || c > 126) {
                std::string hex;
                char b[4];
                for (unsigned char x : s) {
                    snprintf(b, sizeof b, hex.empty() ? "%02x" : ":%02x", x);
                    hex += b;
                }
                s = hex;
                return;
            }
    };
    printable(chassis);
    printable(port);
    std::string text = chassis + " / " + port;
    std::lock_guard<std::mutex> lock(mutex_);
    if (text != neighbour_ && log_) log_("PROFINET: neighbour on " + stack_->ifname() + ": " + text);
    neighbour_ = text;
    neighbourTtl_ = ttl;
    neighbourSeen_ = nowUs();
}

std::string Lldp::neighbour() {
    std::lock_guard<std::mutex> lock(mutex_);
    return neighbour_;
}

}  // namespace pn
}  // namespace vplc
