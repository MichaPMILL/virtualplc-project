#include "cpu.h"

#include <stdio.h>
#include <string.h>

#include "bytes.h"
#include "isa.h"
#include "protocol.h"

namespace vplc {

namespace {
constexpr uint8_t NO_PROGRAM = uint8_t(CpuState::CPU_NO_PROGRAM);
constexpr uint8_t STOP = uint8_t(CpuState::CPU_STOP);
constexpr uint8_t RUN = uint8_t(CpuState::CPU_RUN);
constexpr uint8_t FAULT = uint8_t(CpuState::CPU_FAULT);
}  // namespace

const char* stateName(uint8_t s) {
    switch (s) {
        case NO_PROGRAM: return "NO_PROGRAM";
        case STOP: return "STOP";
        case RUN: return "RUN";
        default: return "FAULT";
    }
}

Cpu::Cpu(Platform& platform, uint8_t* programBuffer, size_t programCapacity, uint8_t* arena, size_t arenaCapacity)
    : platform_(platform), image_(programBuffer), imageCapacity_(programCapacity), arena_(arena),
      arenaCapacity_(arenaCapacity), state_(NO_PROGRAM) {
    memset(logs_, 0, sizeof logs_);
    host_.cpu = this;
}

void Cpu::setName(const char* name) {
    snprintf(name_, sizeof name_, "%s", name ? name : "PLC_1");
}

void Cpu::setPassword(const char* password) {
    snprintf(password_, sizeof password_, "%s", password ? password : "");
}

void Cpu::log(const char* message) {
    LogEntry& e = logs_[logSeq_ % VPLC_LOG_ENTRIES];
    e.seq = ++logSeq_;
    e.time = platform_.millis();
    snprintf(e.text, sizeof e.text, "%s", message);
    platform_.log(message);
}

void Cpu::begin(bool autoStart) {
    size_t len = platform_.loadProgram(image_, imageCapacity_);
    if (len == 0) {
        log("No program stored");
        return;
    }
    const char* err = loadImage(len);
    if (err) {
        char msg[96];
        snprintf(msg, sizeof msg, "Stored program rejected: %s", err);
        log(msg);
        return;
    }
    if (autoStart) start(false);
}

const char* Cpu::loadImage(size_t length) {
    vm_.unload();
    state_ = NO_PROGRAM;
    const char* err = parseProgram(image_, length, program_);
    if (err) return err;
    if (Vm::arenaSize(program_) > arenaCapacity_) return "program needs more data memory than the device has";
    if (program_.stackCells > VPLC_MAX_STACK || program_.callDepth > VPLC_MAX_CALL_DEPTH) {
        // The compiler's limits are upper bounds; the VM's own limits are enforced at run time.
    }
    if (!vm_.load(&program_, arena_, arenaCapacity_, &host_)) return "cannot load program";
    vm_.setWatchdog(watchdogMs_);
    modules_ = platform_.configureIo(program_);
    state_ = STOP;
    char msg[96];
    snprintf(msg, sizeof msg, "Program '%s' loaded (%08lx)", program_.name, static_cast<unsigned long>(program_.id));
    log(msg);
    return nullptr;
}

const char* Cpu::start(bool cold) {
    if (state_ == NO_PROGRAM) return "no program loaded";
    if (state_ == RUN) return nullptr;
    // A warm restart keeps data memory, except after a fault (undefined state).
    if (cold || state_ == FAULT || scans_ == 0) vm_.reset();
    scans_ = 0;
    maxScanUs_ = 0;
    state_ = RUN;
    Vm::Result r = vm_.startup(platform_.millis());
    if (r == Vm::TRAPPED) {
        state_ = FAULT;
        safeOutputs();
        log("FAULT in startup OB");
        return "fault in startup OB";
    }
    lastScan_ = platform_.millis() - program_.cycleMs;
    log(cold ? "CPU started (cold restart)" : "CPU started");
    return nullptr;
}

void Cpu::stop() {
    if (state_ == RUN) log("CPU stopped");
    if (state_ == RUN || state_ == FAULT) state_ = state_ == FAULT ? FAULT : STOP;
    safeOutputs();
}

void Cpu::safeOutputs() {
    uint32_t size;
    uint8_t* q = vm_.area(uint8_t(Area::Q), size);
    if (q) {
        memset(q, 0, size);
        platform_.writeOutputs(q, size);
    }
}

void Cpu::applyForces(uint8_t area, uint8_t* image, uint32_t size) {
    for (uint8_t k = 0; k < forceCount_; k++) {
        const Force& f = forces_[k];
        if (f.area != area || f.byte >= size) continue;
        if (f.value) image[f.byte] |= uint8_t(1u << f.bit);
        else image[f.byte] &= uint8_t(~(1u << f.bit));
    }
}

uint32_t Cpu::loop() {
    if (state_ != RUN) return 20;
    uint32_t now = platform_.millis();
    uint32_t cycle = program_.cycleMs;
    uint32_t elapsed = now - lastScan_;
    if (elapsed < cycle) return cycle - elapsed;
    // Keep a steady rhythm, but never try to catch up missed cycles.
    lastScan_ = elapsed > 2 * cycle ? now : lastScan_ + cycle;

    uint32_t t0 = platform_.micros();
    uint32_t isize, qsize;
    uint8_t* in = vm_.area(uint8_t(Area::I), isize);
    uint8_t* q = vm_.area(uint8_t(Area::Q), qsize);
    platform_.readInputs(in, isize);
    applyForces(uint8_t(Area::I), in, isize);

    Vm::Result r = vm_.scan(now);
    if (r == Vm::TRAPPED) {
        state_ = FAULT;
        safeOutputs();
        const Fault& f = vm_.fault();
        char msg[96];
        snprintf(msg, sizeof msg, "FAULT %s in function %u line %u (pc %lu)", trapName(f.code), unsigned(f.function),
                 unsigned(f.line), static_cast<unsigned long>(f.pc));
        log(msg);
        return 20;
    }
    applyForces(uint8_t(Area::Q), q, qsize);
    platform_.writeOutputs(q, qsize);

    scans_++;
    scanUs_ = platform_.micros() - t0;
    if (scanUs_ > maxScanUs_) maxScanUs_ = scanUs_;
    uint32_t spent = platform_.millis() - now;
    return spent >= cycle ? 0 : cycle - spent;
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

size_t Cpu::info(char* out, size_t cap) {
    JsonWriter j(out, cap);
    j.open('{');
    j.key("protocol").num(ISA_VERSION);
    j.key("device").str(platform_.deviceType());
    j.key("firmware").str(VPLC_FIRMWARE_VERSION);
    j.key("name").str(name_);
    j.key("maxPayload").num(VPLC_MAX_PAYLOAD);
    j.key("maxProgram").num(int64_t(imageCapacity_));
    j.key("maxData").num(int64_t(arenaCapacity_));
    j.key("auth").raw(password_[0] ? "true" : "false");
    j.close('}');
    return j.length();
}

size_t Cpu::stateJson(char* out, size_t cap) {
    JsonWriter j(out, cap);
    char id[12];
    snprintf(id, sizeof id, "%08lx", static_cast<unsigned long>(program_.id));
    j.open('{');
    j.key("state").str(stateName(state_));
    if (state_ == NO_PROGRAM) {
        j.key("programId").raw("null");
    } else {
        j.key("programId").str(id);
        j.key("programName").str(program_.name);
        j.key("cycleMs").num(program_.cycleMs);
    }
    j.key("scans").num(scans_);
    j.key("scanUs").num(scanUs_);
    j.key("maxScanUs").num(maxScanUs_);
    j.key("forces").num(forceCount_);
    j.key("logSeq").num(logSeq_);
    j.key("uptimeMs").num(platform_.millis());
    j.key("fault");
    if (state_ == FAULT) {
        const Fault& f = vm_.fault();
        j.open('{');
        j.key("code").str(trapName(f.code));
        j.key("function").num(f.function == 0xFFFF ? -1 : f.function);
        j.key("line").num(f.line);
        j.key("pc").num(f.pc);
        j.close('}');
    } else {
        j.raw("null");
    }
    j.key("io").open('[');
    for (uint16_t m = 0; m < modules_; m++) {
        j.open('{');
        j.key("module").num(m);
        j.key("ok").raw(platform_.moduleOk(m) ? "true" : "false");
        j.close('}');
    }
    j.close(']');
    j.close('}');
    return j.length();
}

size_t Cpu::logsJson(uint32_t from, char* out, size_t cap) {
    JsonWriter j(out, cap);
    j.open('[');
    uint32_t first = logSeq_ > VPLC_LOG_ENTRIES ? logSeq_ - VPLC_LOG_ENTRIES + 1 : 1;
    if (from < first) from = first;
    for (uint32_t seq = from; seq <= logSeq_; seq++) {
        const LogEntry& e = logs_[(seq - 1) % VPLC_LOG_ENTRIES];
        if (e.seq != seq) continue;
        size_t before = j.length();
        j.open('{').key("seq").num(e.seq).key("t").num(e.time).key("msg").str(e.text).close('}');
        if (j.overflow() || j.length() + 2 >= cap) {
            out[before] = 0;  // drop the entry that did not fit
            break;
        }
    }
    j.close(']');
    return j.length();
}

size_t Cpu::handle(Session& session, uint8_t command, uint8_t seq, const uint8_t* p, uint32_t len, uint8_t* out) {
    uint8_t* payload = out + 9;
    const uint32_t cap = VPLC_MAX_PAYLOAD;
    uint32_t n = 0;
    uint8_t status = uint8_t(Status::ST_OK);
    auto fail = [&](Status s, const char* message) {
        status = uint8_t(s);
        n = uint32_t(snprintf(reinterpret_cast<char*>(payload), cap, "%s", message));
    };

    Command cmd = Command(command);
    if (password_[0] && !session.authenticated && cmd != Command::CMD_INFO && cmd != Command::CMD_AUTH) {
        fail(Status::ST_UNAUTHORIZED, "authentication required");
        return encodeResponse(out, command, seq, status, payload, n);
    }

    switch (cmd) {
        case Command::CMD_INFO:
            n = uint32_t(info(reinterpret_cast<char*>(payload), cap));
            break;
        case Command::CMD_AUTH: {
            char given[33] = {0};
            memcpy(given, p, len < 32 ? len : 32);
            // Constant-time comparison
            uint8_t diff = uint8_t(strlen(given) != strlen(password_));
            for (size_t k = 0; k < sizeof password_; k++) diff |= uint8_t(given[k] ^ password_[k]);
            if (password_[0] && diff) fail(Status::ST_UNAUTHORIZED, "wrong password");
            else session.authenticated = true;
            break;
        }
        case Command::CMD_STATE:
            n = uint32_t(stateJson(reinterpret_cast<char*>(payload), cap));
            break;
        case Command::CMD_STOP:
            stop();
            break;
        case Command::CMD_START: {
            const char* err = start(len > 0 && p[0] == 1);
            if (err) fail(state_ == NO_PROGRAM ? Status::ST_BAD_STATE : Status::ST_ERROR, err);
            break;
        }
        case Command::CMD_DOWNLOAD_BEGIN: {
            if (len < 8) { fail(Status::ST_BAD_REQUEST, "size and crc expected"); break; }
            uint32_t size = rd32le(p), crc = rd32le(p + 4);
            if (size > imageCapacity_) { fail(Status::ST_TOO_LARGE, "program too large for this device"); break; }
            if (state_ == RUN) log("CPU stopped for download");
            state_ = NO_PROGRAM;
            safeOutputs();
            vm_.unload();
            downloading_ = true;
            downloadSize_ = size;
            downloadCrc_ = crc;
            received_ = 0;
            break;
        }
        case Command::CMD_DOWNLOAD_CHUNK: {
            if (!downloading_) { fail(Status::ST_BAD_STATE, "no download in progress"); break; }
            if (len < 4) { fail(Status::ST_BAD_REQUEST, "offset expected"); break; }
            uint32_t offset = rd32le(p);
            uint32_t size = len - 4;
            if (offset != received_ || offset + size > downloadSize_) { fail(Status::ST_BAD_REQUEST, "unexpected chunk offset"); break; }
            memcpy(image_ + offset, p + 4, size);
            received_ += size;
            break;
        }
        case Command::CMD_DOWNLOAD_END: {
            if (!downloading_) { fail(Status::ST_BAD_STATE, "no download in progress"); break; }
            downloading_ = false;
            const char* err = nullptr;
            if (received_ != downloadSize_) err = "incomplete download";
            else if (crc32(image_, downloadSize_) != downloadCrc_) err = "download checksum mismatch";
            else err = loadImage(downloadSize_);
            if (!err && !platform_.storeProgram(image_, downloadSize_)) err = "cannot store the program";
            if (err) {
                fail(Status::ST_ERROR, err);
                char msg[96];
                snprintf(msg, sizeof msg, "Download rejected: %s", err);
                log(msg);
                // Restore the previous program
                size_t old = platform_.loadProgram(image_, imageCapacity_);
                if (old) loadImage(old);
            } else {
                log("Program downloaded");
            }
            break;
        }
        case Command::CMD_READ: {
            if (state_ == NO_PROGRAM) { fail(Status::ST_BAD_STATE, "no program loaded"); break; }
            for (uint32_t k = 0; k + 7 <= len; k += 7) {
                uint32_t size;
                uint8_t* area = vm_.area(p[k], size);
                uint32_t offset = rd32le(p + k + 1);
                uint16_t count = rd16le(p + k + 5);
                if (!area || uint64_t(offset) + count > size) { fail(Status::ST_BAD_REQUEST, "address out of range"); break; }
                if (n + count > cap) { fail(Status::ST_TOO_LARGE, "response too large"); break; }
                memcpy(payload + n, area + offset, count);
                n += count;
            }
            break;
        }
        case Command::CMD_WRITE: {
            if (state_ == NO_PROGRAM) { fail(Status::ST_BAD_STATE, "no program loaded"); break; }
            uint32_t k = 0;
            while (k + 8 <= len) {
                uint32_t size;
                uint8_t* area = vm_.area(p[k], size);
                uint32_t offset = rd32le(p + k + 1);
                uint8_t bit = p[k + 5];
                uint16_t count = rd16le(p + k + 6);
                k += 8;
                if (k + count > len || !area || uint64_t(offset) + (bit == 0xFF ? count : 1) > size) {
                    fail(Status::ST_BAD_REQUEST, "address out of range");
                    break;
                }
                if (bit == 0xFF) memcpy(area + offset, p + k, count);
                else if (count >= 1 && p[k]) area[offset] |= uint8_t(1u << (bit & 7));
                else area[offset] &= uint8_t(~(1u << (bit & 7)));
                k += count;
            }
            break;
        }
        case Command::CMD_FORCE: {
            for (uint32_t k = 0; k + 7 <= len; k += 7) {
                uint8_t area = p[k];
                uint32_t byte = rd32le(p + k + 1);
                uint8_t bit = p[k + 5] & 7, value = p[k + 6];
                if ((area != uint8_t(Area::I) && area != uint8_t(Area::Q)) || byte > 0xFFFF) {
                    fail(Status::ST_BAD_REQUEST, "only %I and %Q bits can be forced");
                    break;
                }
                uint8_t found = forceCount_;
                for (uint8_t f = 0; f < forceCount_; f++) {
                    if (forces_[f].area == area && forces_[f].byte == byte && forces_[f].bit == bit) found = f;
                }
                if (value == 2) {  // remove
                    if (found < forceCount_) forces_[found] = forces_[--forceCount_];
                    continue;
                }
                if (found == forceCount_) {
                    if (forceCount_ >= VPLC_MAX_FORCES) { fail(Status::ST_TOO_LARGE, "too many forces"); break; }
                    forceCount_++;
                }
                forces_[found] = Force{area, uint16_t(byte), bit, uint8_t(value ? 1 : 0)};
            }
            break;
        }
        case Command::CMD_UNFORCE_ALL:
            forceCount_ = 0;
            break;
        case Command::CMD_LOGS:
            n = uint32_t(logsJson(len >= 4 ? rd32le(p) : 0, reinterpret_cast<char*>(payload), cap));
            break;
        case Command::CMD_UPLOAD: {
            if (state_ == NO_PROGRAM) { fail(Status::ST_BAD_STATE, "no program loaded"); break; }
            uint32_t offset = len >= 4 ? rd32le(p) : 0;
            size_t total = 0;
            // The image length is not kept: recompute it from the header
            // (sections are contiguous, CRC at the end).
            {
                uint16_t count = rd16le(image_ + 6);
                size_t pos = 8;
                for (uint16_t s = 0; s < count; s++) pos += 5 + rd32le(image_ + pos + 1);
                total = pos + 4;
            }
            if (offset > total) { fail(Status::ST_BAD_REQUEST, "offset out of range"); break; }
            uint32_t chunk = uint32_t(total - offset) < cap - 4 ? uint32_t(total - offset) : cap - 4;
            wr32le(payload, uint32_t(total));
            memcpy(payload + 4, image_ + offset, chunk);
            n = chunk + 4;
            break;
        }
        default:
            fail(Status::ST_BAD_REQUEST, "unknown command");
    }
    return encodeResponse(out, command, seq, status, payload, n);
}

}  // namespace vplc
