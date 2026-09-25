// Users, roles and audit trail of the Linux CPU (IEC 62443-3-3 SR 1.1 / 1.3 / 1.5 / 1.7 / 1.11, SR 2.1, SR 2.8-2.10, SR 3.9)
//
// Users: <data dir>/users (mode 0600), one line per user:
//   name \t role \t iterations \t salt (base64) \t PBKDF2-HMAC-SHA256 (base64) \t changed (unix time)
// Audit: <data dir>/audit.log, one JSON object per line, hash-chained and Ed25519-signed
// with the CPU identity (<data dir>/identity.pem, the key of the traceability):
//   chain(n) = sha256hex(chain(n-1) + "|" + seq|ts_ms|user|peer|action|detail), chain(0) = sha256hex("VirtualPLC audit|" + plc)
#pragma once

#include <stdint.h>

#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <string>

#include "datalog/net.h"

namespace vplc::sec {

struct User {
    uint8_t role = 0;
    uint32_t iterations = 0;
    std::string salt, hash;  // raw
    int64_t changed = 0;
};

class Security {
public:
    explicit Security(std::string dataDir);

    void setPlcName(const std::string& name);
    bool hasUsers();
    uint8_t authenticate(const std::string& user, const std::string& password);
    // USERS request: u8 op + fields separated by \0
    //   0 list | 1 add or replace: name, password, role digit (admin) | 2 delete: name (admin)
    //   3 set password: name, password (admin) | 4 change own password: old, new
    //   5 list trusted engineering keys | 6 trust a key: name, public key hex (admin) | 7 remove a key: name (admin)
    const char* users(const uint8_t* request, uint32_t length, const std::string& user, const std::string& peer, uint8_t role, std::string& out);

    void audit(const std::string& user, const std::string& peer, const std::string& action, const std::string& detail);
    size_t auditRead(uint32_t from, uint16_t count, char* out, size_t cap);

    // Command line (vplc-cpu --add-user): creates or replaces a user
    const char* setUser(const std::string& name, const std::string& password, uint8_t role);

    // Signed programs (IEC 62443-3-3 SR 3.4, software integrity)
    void setSignedRequired(bool on) { signedRequired_ = on; }
    bool signedRequired() const { return signedRequired_; }
    // signature = public key (32) + Ed25519 signature (64) of "VirtualPLC program|" + sha256hex(image)
    const char* verifyProgram(const uint8_t* image, size_t length, const std::string& signature, std::string& signer);
    const char* trustKey(const std::string& name, const std::string& publicKeyHex);

    static const char* checkPassword(const std::string& password);
    static bool validName(const std::string& name);

private:
    bool loadUsers();
    bool saveUsers();
    User makeUser(const std::string& password, uint8_t role);
    void loadAudit();
    bool loadKeys();
    bool saveKeys();
    std::map<std::string, std::string> keys_;  // name -> public key (raw 32 bytes)
    bool keysLoaded_ = false;
    bool signedRequired_ = false;

    std::string dataDir_, plcName_ = "PLC_1";
    std::map<std::string, User> users_;
    bool usersLoaded_ = false;
    std::string error_;
    uint32_t iterations_ = 0;

    std::mutex auditMutex_;
    bool auditLoaded_ = false;
    uint64_t auditSeq_ = 0;
    std::string auditChain_;         // hex
    std::deque<std::string> recent_;  // last records (JSON lines)
    db::Identity identity_;
    bool identityOk_ = false;
};

}  // namespace vplc::sec
