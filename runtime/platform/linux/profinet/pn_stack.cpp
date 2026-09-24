// PROFINET stack of a network interface (see pn_stack.h).
#include "pn_stack.h"

#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <string.h>
#include <sys/eventfd.h>
#include <time.h>
#include <unistd.h>

#include <algorithm>

namespace vplc {
namespace pn {

bool Stack::open(std::string& error) {
    if (!raw_.open(ifname_, error)) return false;
    if (!rpc_.open(RPC_PORT, error)) {
        raw_.close();
        return false;
    }
    return true;
}

void Stack::start() {
    if (thread_.joinable()) return;
    wake_ = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
    stop_ = false;
    thread_ = std::thread([this] { loop(); });
    // real-time priority: cyclic frames and watchdogs of a few milliseconds must not wait
    // for the other processes (needs CAP_SYS_NICE, or root, or the systemd unit)
    sched_param sp{};
    sp.sched_priority = 60;
    int rc = pthread_setschedparam(thread_.native_handle(), SCHED_FIFO, &sp);
    if (rc != 0)
        log("PROFINET: no real-time priority for the stack thread (" + std::string(strerror(rc)) +
            "): short update times may be disturbed by the load of the system — give the CPU CAP_SYS_NICE");
}

void Stack::stop() {
    if (thread_.joinable()) {
        stop_ = true;
        uint64_t one = 1;
        if (::write(wake_, &one, sizeof(one)) < 0) log("PROFINET: cannot wake the stack thread");
        thread_.join();
    }
    if (wake_ >= 0) close(wake_);
    wake_ = -1;
    raw_.close();
    rpc_.close();
}

void Stack::loop() {
    std::vector<uint8_t> buf(2048);
    uint64_t next = nowUs();
    while (!stop_) {
        uint64_t now = nowUs();
        int64_t wait = int64_t(next) - int64_t(now);
        if (wait < 0) wait = 0;
        if (wait > 50000) wait = 50000;
        pollfd fds[3] = {{raw_.fd(), POLLIN, 0}, {rpc_.fd(), POLLIN, 0}, {wake_, POLLIN, 0}};
        timespec ts{time_t(wait / 1000000), long(wait % 1000000) * 1000};
        int ready = ppoll(fds, 3, &ts, nullptr);
        if (stop_) break;
        if (ready > 0) {
            if (fds[0].revents & POLLIN)
                for (int i = 0; i < 64; i++) {
                    size_t n = raw_.receive(buf.data(), buf.size());
                    if (!n) break;
                    for (Role* r : roles_) r->onFrame(buf.data(), n);
                }
            if (fds[1].revents & POLLIN)
                for (int i = 0; i < 16; i++) {
                    sockaddr_in from{};
                    size_t n = rpc_.receive(buf.data(), buf.size(), from);
                    if (!n) break;
                    for (Role* r : roles_)
                        if (r->onRpc(buf.data(), n, from)) break;
                }
        }
        now = nowUs();
        next = now + 50000;
        for (Role* r : roles_) next = std::min(next, r->tick(now));
    }
    for (Role* r : roles_) r->onStop();
}

}  // namespace pn
}  // namespace vplc
