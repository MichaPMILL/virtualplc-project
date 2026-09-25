#include "security.h"

#include <fcntl.h>
#include <ctype.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <syslog.h>
#include <time.h>
#include <unistd.h>

#include <chrono>
#include <fstream>
#include <sstream>
#include <vector>

namespace vplc::sec {

namespace {

constexpr uint32_t MIN_ITERATIONS = 100000;  // OWASP floor for PBKDF2-HMAC-SHA256 is higher; see docs/security.md
constexpr size_t RECENT = 2000;
constexpr off_t ROTATE_BYTES = 16 * 1024 * 1024;

std::string pbkdf2(const std::string& password, const std::string& salt, uint32_t iterations) {
    unsigned char out[32];
    PKCS5_PBKDF2_HMAC(password.data(), int(password.size()), reinterpret_cast<const unsigned char*>(salt.data()), int(salt.size()),
                      int(iterations), EVP_sha256(), sizeof out, out);
    return std::string(reinterpret_cast<char*>(out), sizeof out);
}

std::string jsonText(const std::string& s) {
    std::string o = "\"";
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += char(c); }
        else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += char(c);
    }
    return o + "\"";
}

// Separators are escaped so that fields cannot be confused in the chained form
std::string field(const std::string& s) {
    std::string o;
    for (char c : s) {
        if (c == '|' || c == '\\') o += '\\';
        o += c;
    }
    return o;
}

const char* roleText(uint8_t role) {
    switch (role) {
        case 1: return "viewer";
        case 2: return "operator";
        case 3: return "engineer";
        case 4: return "admin";
        default: return "none";
    }
}

std::string isoTime(int64_t ms) {
    time_t t = time_t(ms / 1000);
    struct tm tm;
    gmtime_r(&t, &tm);
    char b[64];
    snprintf(b, sizeof b, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min,
             tm.tm_sec, int(ms % 1000));
    return b;
}

// Value of "key":"..." or "key":123 in one of our own JSON lines
std::string jsonField(const std::string& line, const std::string& key) {
    std::string k = "\"" + key + "\":";
    size_t p = line.find(k);
    if (p == std::string::npos) return "";
    p += k.size();
    if (p < line.size() && line[p] == '"') {
        size_t e = line.find('"', p + 1);
        return e == std::string::npos ? "" : line.substr(p + 1, e - p - 1);
    }
    size_t e = line.find_first_of(",}", p);
    return line.substr(p, e - p);
}

}  // namespace

Security::Security(std::string dataDir) : dataDir_(std::move(dataDir)) {}

void Security::setPlcName(const std::string& name) { plcName_ = name; }

bool Security::validName(const std::string& name) {
    if (name.empty() || name.size() > 32) return false;
    for (char c : name) {
        if (!isalnum(static_cast<unsigned char>(c)) && c != '.' && c != '_' && c != '-') return false;
    }
    return true;
}

// Password policy (IEC 62443-4-2 CR 1.7): at least 10 characters, 3 kinds out of lower / upper / digit / other
const char* Security::checkPassword(const std::string& password) {
    if (password.size() < 10) return "the password must have at least 10 characters";
    if (password.size() > 128) return "the password is too long (128 characters max)";
    int lower = 0, upper = 0, digit = 0, other = 0;
    for (unsigned char c : password) {
        if (islower(c)) lower = 1;
        else if (isupper(c)) upper = 1;
        else if (isdigit(c)) digit = 1;
        else other = 1;
    }
    if (lower + upper + digit + other < 3) return "the password must mix at least 3 kinds of characters (lower case, upper case, digits, symbols)";
    return nullptr;
}

bool Security::loadUsers() {
    if (usersLoaded_) return true;
    usersLoaded_ = true;
    std::ifstream in(dataDir_ + "/users");
    std::string line;
    while (std::getline(in, line)) {
        if (line.empty() || line[0] == '#') continue;
        std::vector<std::string> f;
        std::stringstream ss(line);
        std::string part;
        while (std::getline(ss, part, '\t')) f.push_back(part);
        if (f.size() < 5 || !validName(f[0])) continue;
        User u;
        u.role = uint8_t(atoi(f[1].c_str()));
        u.iterations = uint32_t(strtoul(f[2].c_str(), nullptr, 10));
        u.salt = db::unbase64(f[3]);
        u.hash = db::unbase64(f[4]);
        u.changed = f.size() > 5 ? atoll(f[5].c_str()) : 0;
        if (u.role < 1 || u.role > 4 || u.iterations == 0 || u.hash.size() != 32) continue;
        users_[f[0]] = u;
    }
    return true;
}

bool Security::saveUsers() {
    std::string path = dataDir_ + "/users", tmp = path + ".tmp";
    int fd = open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (fd < 0) return false;
    std::string text = "# VirtualPLC users: name, role (1 viewer, 2 operator, 3 engineer, 4 admin), PBKDF2-HMAC-SHA256\n";
    for (auto& [name, u] : users_) {
        text += name + "\t" + std::to_string(u.role) + "\t" + std::to_string(u.iterations) + "\t" + db::base64(u.salt) + "\t" +
                db::base64(u.hash) + "\t" + std::to_string(u.changed) + "\n";
    }
    bool ok = write(fd, text.data(), text.size()) == ssize_t(text.size()) && fsync(fd) == 0;
    close(fd);
    return ok && rename(tmp.c_str(), path.c_str()) == 0;
}

User Security::makeUser(const std::string& password, uint8_t role) {
    if (!iterations_) {
        // Calibrate: about 20 ms per check on this machine (the CPU thread checks logins
        // between two scans), never less than MIN_ITERATIONS
        auto t0 = std::chrono::steady_clock::now();
        pbkdf2("calibration", "0123456789abcdef", 20000);
        double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        uint32_t n = ms > 0 ? uint32_t(20000 * 20.0 / ms) : MIN_ITERATIONS;
        iterations_ = n < MIN_ITERATIONS ? MIN_ITERATIONS : n;
    }
    User u;
    u.role = role;
    u.iterations = iterations_;
    u.salt = db::randomBytes(16);
    u.hash = pbkdf2(password, u.salt, u.iterations);
    u.changed = int64_t(time(nullptr));
    return u;
}

bool Security::hasUsers() {
    loadUsers();
    return !users_.empty();
}

uint8_t Security::authenticate(const std::string& user, const std::string& password) {
    loadUsers();
    auto it = users_.find(user);
    // Unknown users cost the same time as known ones (no user enumeration)
    static const std::string dummySalt = db::randomBytes(16);
    const User* u = it != users_.end() ? &it->second : nullptr;
    std::string hash = pbkdf2(password, u ? u->salt : dummySalt, u ? u->iterations : (iterations_ ? iterations_ : MIN_ITERATIONS));
    if (!u || CRYPTO_memcmp(hash.data(), u->hash.data(), 32) != 0) return 0;
    return u->role;
}

const char* Security::setUser(const std::string& name, const std::string& password, uint8_t role) {
    loadUsers();
    if (!validName(name)) return "invalid user name (1 to 32 letters, digits, '.', '_' or '-')";
    if (role < 1 || role > 4) return "invalid role";
    if (const char* e = checkPassword(password)) return e;
    users_[name] = makeUser(password, role);
    if (!saveUsers()) return "cannot write the users file";
    return nullptr;
}

const char* Security::users(const uint8_t* request, uint32_t length, const std::string& user, const std::string& peer, uint8_t role, std::string& out) {
    loadUsers();
    uint8_t op = length ? request[0] : 0;
    std::vector<std::string> f;
    {
        std::string cur;
        for (uint32_t k = 1; k < length; k++) {
            if (request[k] == 0) { f.push_back(cur); cur.clear(); }
            else cur += char(request[k]);
        }
        if (length > 1) f.push_back(cur);
    }
    // passwords are wiped from memory once used (the user name, field 0 of ops 1 to 3, is kept)
    auto wipe = [&]() { for (size_t k = op == 4 ? 0 : 1; k < f.size(); k++) OPENSSL_cleanse(&f[k][0], f[k].size()); };
    auto countAdmins = [&]() { int n = 0; for (auto& [k, u] : users_) n += u.role == 4; return n; };
    const bool admin = role >= 4;
    error_.clear();

    switch (op) {
        case 0: {  // list (no hashes)
            out = "{\"users\":[";
            bool first = true;
            for (auto& [name, u] : users_) {
                if (!admin && name != user) continue;
                out += first ? "" : ",";
                first = false;
                out += "{\"name\":" + jsonText(name) + ",\"role\":\"" + roleText(u.role) + "\",\"changed\":" + std::to_string(u.changed) + "}";
            }
            out += "],\"self\":" + jsonText(user) + "}";
            return nullptr;
        }
        case 1: {  // add or replace
            if (!admin) return "only an administrator can manage users";
            if (f.size() < 3) { wipe(); return "name, password and role expected"; }
            uint8_t r = uint8_t(atoi(f[2].c_str()));
            auto it = users_.find(f[0]);
            if (it != users_.end() && it->second.role == 4 && r != 4 && countAdmins() == 1) { wipe(); return "the last administrator cannot be downgraded"; }
            const char* e = setUser(f[0], f[1], r);
            wipe();
            if (e) return e;
            audit(user, peer, "user set", f[0] + " (" + roleText(r) + ")");
            out = "{}";
            return nullptr;
        }
        case 2: {  // delete
            if (!admin) return "only an administrator can manage users";
            if (f.empty()) return "name expected";
            auto it = users_.find(f[0]);
            if (it == users_.end()) return "unknown user";
            if (it->second.role == 4 && countAdmins() == 1) return "the last administrator cannot be deleted";
            users_.erase(it);
            if (!saveUsers()) return "cannot write the users file";
            audit(user, peer, "user deleted", f[0]);
            out = "{}";
            return nullptr;
        }
        case 3: {  // reset the password of a user
            if (!admin) { wipe(); return "only an administrator can reset passwords"; }
            if (f.size() < 2) { wipe(); return "name and password expected"; }
            auto it = users_.find(f[0]);
            if (it == users_.end()) { wipe(); return "unknown user"; }
            const char* e = setUser(f[0], f[1], it->second.role);
            wipe();
            if (e) return e;
            audit(user, peer, "password reset", f[0]);
            out = "{}";
            return nullptr;
        }
        case 4: {  // change own password
            if (f.size() < 2) { wipe(); return "old and new passwords expected"; }
            auto it = users_.find(user);
            if (it == users_.end()) { wipe(); return "no user account (CPU password only)"; }
            if (!authenticate(user, f[0])) { wipe(); audit(user, peer, "password change failed", ""); return "wrong current password"; }
            const char* e = setUser(user, f[1], it->second.role);
            wipe();
            if (e) return e;
            audit(user, peer, "password changed", "");
            out = "{}";
            return nullptr;
        }
        case 5: {  // trusted engineering keys
            loadKeys();
            out = "{\"required\":" + std::string(signedRequired_ ? "true" : "false") + ",\"keys\":[";
            bool first = true;
            for (auto& [name, key] : keys_) {
                out += (first ? "" : ",") + std::string("{\"name\":") + jsonText(name) + ",\"key\":\"" + db::toHex(key) + "\"}";
                first = false;
            }
            out += "]}";
            return nullptr;
        }
        case 6: {
            if (!admin) return "only an administrator can manage the trusted keys";
            if (f.size() < 2) return "name and key expected";
            if (const char* e = trustKey(f[0], f[1])) return e;
            audit(user, peer, "key trusted", f[0] + " " + f[1].substr(0, 16));
            out = "{}";
            return nullptr;
        }
        case 7: {
            if (!admin) return "only an administrator can manage the trusted keys";
            loadKeys();
            if (f.empty() || !keys_.erase(f[0])) return "unknown key";
            if (!saveKeys()) return "cannot write the trusted keys file";
            audit(user, peer, "key removed", f[0]);
            out = "{}";
            return nullptr;
        }
        default:
            return "unknown user operation";
    }
}

// ---------------------------------------------------------------------------
// Signed programs: <data dir>/trusted-keys, "name \t public key hex" per line
// ---------------------------------------------------------------------------

bool Security::loadKeys() {
    if (keysLoaded_) return true;
    keysLoaded_ = true;
    std::ifstream in(dataDir_ + "/trusted-keys");
    std::string line;
    while (std::getline(in, line)) {
        size_t tab = line.find('\t');
        if (line.empty() || line[0] == '#' || tab == std::string::npos) continue;
        std::string hex = line.substr(tab + 1);
        std::string raw;
        for (size_t k = 0; k + 1 < hex.size() && raw.size() < 32; k += 2) raw += char(strtoul(hex.substr(k, 2).c_str(), nullptr, 16));
        if (raw.size() == 32) keys_[line.substr(0, tab)] = raw;
    }
    return true;
}

bool Security::saveKeys() {
    std::string path = dataDir_ + "/trusted-keys", tmp = path + ".tmp";
    int fd = open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (fd < 0) return false;
    std::string text = "# VirtualPLC trusted engineering keys (Ed25519): name, public key\n";
    for (auto& [name, key] : keys_) text += name + "\t" + db::toHex(key) + "\n";
    bool ok = write(fd, text.data(), text.size()) == ssize_t(text.size()) && fsync(fd) == 0;
    close(fd);
    return ok && rename(tmp.c_str(), path.c_str()) == 0;
}

const char* Security::trustKey(const std::string& name, const std::string& publicKeyHex) {
    loadKeys();
    if (!validName(name)) return "invalid key name (1 to 32 letters, digits, '.', '_' or '-')";
    if (publicKeyHex.size() != 64 || publicKeyHex.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos) return "the key must be 64 hexadecimal digits";
    std::string raw;
    for (size_t k = 0; k < 64; k += 2) raw += char(strtoul(publicKeyHex.substr(k, 2).c_str(), nullptr, 16));
    keys_[name] = raw;
    return saveKeys() ? nullptr : "cannot write the trusted keys file";
}

const char* Security::verifyProgram(const uint8_t* image, size_t length, const std::string& signature, std::string& signer) {
    loadKeys();
    signer.clear();
    if (signature.size() != 96) return signedRequired_ ? "this CPU only accepts signed programs (sign it with a trusted engineering key)" : nullptr;
    std::string pub = signature.substr(0, 32);
    std::string name;
    for (auto& [n, key] : keys_) {
        if (key == pub) name = n;
    }
    if (name.empty()) return signedRequired_ ? "the program is signed by a key this CPU does not trust" : nullptr;
    std::string message = "VirtualPLC program|" + db::toHex(db::sha256(std::string(reinterpret_cast<const char*>(image), length)));
    EVP_PKEY* key = EVP_PKEY_new_raw_public_key(EVP_PKEY_ED25519, nullptr, reinterpret_cast<const unsigned char*>(pub.data()), 32);
    EVP_MD_CTX* ctx = EVP_MD_CTX_new();
    bool ok = key && ctx && EVP_DigestVerifyInit(ctx, nullptr, nullptr, nullptr, key) == 1 &&
              EVP_DigestVerify(ctx, reinterpret_cast<const unsigned char*>(signature.data() + 32), 64,
                               reinterpret_cast<const unsigned char*>(message.data()), message.size()) == 1;
    EVP_MD_CTX_free(ctx);
    EVP_PKEY_free(key);
    if (!ok) return "invalid program signature (the program was changed after it was signed)";
    signer = name;
    return nullptr;
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

void Security::loadAudit() {
    if (auditLoaded_) return;
    auditLoaded_ = true;
    std::string err;
    identityOk_ = identity_.load(dataDir_ + "/identity.pem", err);
    auditChain_ = db::toHex(db::sha256("VirtualPLC audit|" + plcName_));
    for (const char* name : {"/audit.log.1", "/audit.log"}) {
        std::ifstream in(dataDir_ + name);
        std::string line;
        while (std::getline(in, line)) {
            if (line.empty()) continue;
            uint64_t seq = strtoull(jsonField(line, "seq").c_str(), nullptr, 10);
            std::string chain = jsonField(line, "chain");
            if (seq == 0 || chain.size() != 64) continue;
            auditSeq_ = seq;
            auditChain_ = chain;
            recent_.push_back(line);
            if (recent_.size() > RECENT) recent_.pop_front();
        }
    }
}

void Security::audit(const std::string& user, const std::string& peer, const std::string& action, const std::string& detail) {
    std::lock_guard<std::mutex> lock(auditMutex_);
    loadAudit();
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    int64_t ms = int64_t(ts.tv_sec) * 1000 + ts.tv_nsec / 1000000;
    uint64_t seq = ++auditSeq_;
    std::string canonical = std::to_string(seq) + "|" + std::to_string(ms) + "|" + field(user) + "|" + field(peer) + "|" + field(action) +
                            "|" + field(detail);
    auditChain_ = db::toHex(db::sha256(auditChain_ + "|" + canonical));
    std::string sig = identityOk_ ? db::toHex(identity_.sign(auditChain_)) : "";
    std::string line = "{\"seq\":" + std::to_string(seq) + ",\"ts\":" + std::to_string(ms) + ",\"time\":\"" + isoTime(ms) +
                       "\",\"user\":" + jsonText(user) + ",\"peer\":" + jsonText(peer) + ",\"action\":" + jsonText(action) +
                       ",\"detail\":" + jsonText(detail) + ",\"chain\":\"" + auditChain_ + "\",\"sig\":\"" + sig + "\"}";
    recent_.push_back(line);
    if (recent_.size() > RECENT) recent_.pop_front();
    if (syslog_) {
        // one line per record (the chained JSON: the SIEM can verify it too)
        syslog(LOG_AUTHPRIV | (action.find("fail") != std::string::npos || action == "denied" || action == "lockout" || action.find("rejected") != std::string::npos ? LOG_WARNING : LOG_NOTICE),
               "audit %s", line.c_str());
    }

    std::string path = dataDir_ + "/audit.log";
    struct stat st;
    if (stat(path.c_str(), &st) == 0 && st.st_size > ROTATE_BYTES) rename(path.c_str(), (path + ".1").c_str());
    int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    if (fd >= 0) {
        line += "\n";
        (void)!write(fd, line.data(), line.size());
        close(fd);
    }
}

size_t Security::auditRead(uint32_t from, uint16_t count, char* out, size_t cap) {
    std::lock_guard<std::mutex> lock(auditMutex_);
    loadAudit();
    if (count == 0) count = 50;
    // from = 0: the last `count` records; else the records from sequence number `from`
    size_t start = 0;
    if (from == 0) {
        // the latest records that fit in the response
        start = recent_.size();
        size_t room = cap > 400 ? cap - 400 : 0;
        while (start > 0 && recent_.size() - start < count && recent_[start - 1].size() + 1 <= room) {
            room -= recent_[start - 1].size() + 1;
            start--;
        }
    } else {
        while (start < recent_.size() && strtoull(jsonField(recent_[start], "seq").c_str(), nullptr, 10) < from) start++;
    }
    std::string key = identityOk_ ? db::toHex(identity_.publicKey()) : "";
    std::string head = "{\"plc\":" + jsonText(plcName_) + ",\"key\":\"" + key + "\",\"last\":" + std::to_string(auditSeq_) +
                       ",\"first\":" + (recent_.empty() ? std::string("0") : jsonField(recent_.front(), "seq")) + ",\"records\":[";
    std::string body;
    for (size_t k = start, n = 0; k < recent_.size() && n < count; k++, n++) {
        if (head.size() + body.size() + recent_[k].size() + 4 > cap) break;
        body += (n ? "," : "") + recent_[k];
    }
    std::string all = head + body + "]}";
    if (all.size() >= cap) all = "{\"records\":[]}";
    memcpy(out, all.data(), all.size());
    return all.size();
}

}  // namespace vplc::sec
