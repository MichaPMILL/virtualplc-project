// MySQL / MariaDB client/server protocol (https://dev.mysql.com/doc/dev/mysql-server/latest/PAGE_PROTOCOL.html):
// handshake v10, TLS (SSLRequest), authentication caching_sha2_password (fast / full with TLS
// or the server RSA key) and mysql_native_password, COM_QUERY and prepared statements
// (COM_STMT_PREPARE / COM_STMT_EXECUTE, binary protocol).
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/rsa.h>

#include <cstring>

#include "sql.h"

namespace vplc::db {

namespace {

enum : uint32_t {
    CLIENT_LONG_PASSWORD = 1, CLIENT_CONNECT_WITH_DB = 8, CLIENT_PROTOCOL_41 = 0x200, CLIENT_SSL = 0x800,
    CLIENT_TRANSACTIONS = 0x2000, CLIENT_SECURE_CONNECTION = 0x8000, CLIENT_MULTI_RESULTS = 0x20000,
    CLIENT_PLUGIN_AUTH = 0x80000,
};

void le(std::string& s, uint64_t v, int n) {
    for (int k = 0; k < n; k++) s += char(v >> (8 * k));
}
uint64_t rdle(const std::string& s, size_t at, int n) {
    uint64_t v = 0;
    for (int k = 0; k < n; k++) v |= uint64_t(uint8_t(s[at + k])) << (8 * k);
    return v;
}
void lenenc(std::string& s, uint64_t v) {
    if (v < 251) s += char(v);
    else if (v < 65536) { s += char(0xFC); le(s, v, 2); }
    else if (v < 16777216) { s += char(0xFD); le(s, v, 3); }
    else { s += char(0xFE); le(s, v, 8); }
}

std::string xorWith(std::string a, const std::string& b) {
    for (size_t k = 0; k < a.size(); k++) a[k] = char(a[k] ^ b[k % b.size()]);
    return a;
}

class Mysql : public Client {
public:
    bool connect(const Config& c, const std::string& password, std::string& err) override {
        close();
        if (!s_.connect(c.host, c.port, c.timeoutMs, err)) return false;
        std::string h;
        if (!readPacket(h, err)) return fail();
        if (!h.empty() && uint8_t(h[0]) == 0xFF) return (err = serverError(h)), fail();
        if (h.empty() || h[0] != 10) return (err = "unsupported MySQL handshake"), fail();
        size_t p = 1;
        p = h.find('\0', p) + 1;               // server version
        p += 4;                                // connection id
        std::string scramble = h.substr(p, 8);
        p += 9;                                // + filler
        uint32_t caps = uint32_t(rdle(h, p, 2));
        p += 2 + 1 + 2;                        // charset, status
        caps |= uint32_t(rdle(h, p, 2)) << 16;
        p += 2;
        uint8_t authLen = uint8_t(h[p]);
        p += 1 + 10;
        size_t part2 = authLen > 8 ? size_t(authLen - 8) : 13;
        scramble += h.substr(p, part2 > 0 ? part2 - 1 : 0);  // without the final NUL
        p += part2;
        std::string plugin = p < h.size() ? h.substr(p, h.find('\0', p) - p) : "mysql_native_password";

        uint32_t flags = CLIENT_LONG_PASSWORD | CLIENT_CONNECT_WITH_DB | CLIENT_PROTOCOL_41 | CLIENT_TRANSACTIONS |
                         CLIENT_SECURE_CONNECTION | CLIENT_MULTI_RESULTS | CLIENT_PLUGIN_AUTH;
        if (c.tls != Tls::DISABLE) {
            if (!(caps & CLIENT_SSL)) return (err = "the MySQL server does not accept TLS (use TLS = disable only on a trusted network)"), fail();
            flags |= CLIENT_SSL;
            std::string req;
            le(req, flags, 4);
            le(req, 16u << 20, 4);
            req += char(45);  // utf8mb4
            req += std::string(23, '\0');
            if (!writePacket(req, err) || !s_.startTls(c.host, c.tls, err)) return fail();
        }
        std::string resp;
        le(resp, flags, 4);
        le(resp, 16u << 20, 4);
        resp += char(45);
        resp += std::string(23, '\0');
        resp += c.user;
        resp += '\0';
        std::string auth = scrambleFor(plugin, password, scramble);
        resp += char(auth.size());
        resp += auth;
        resp += c.database;
        resp += '\0';
        resp += plugin;
        resp += '\0';
        if (!writePacket(resp, err)) return fail();
        if (!authResult(plugin, password, scramble, err)) return fail();
        open_ = true;
        return true;
    }

    bool exec(const std::string& sql, std::string& err) override {
        seq_ = 0;
        std::string q(1, char(0x03));
        q += sql;
        if (!writePacket(q, err)) return fail();
        std::string r;
        if (!readPacket(r, err)) return fail();
        if (!r.empty() && uint8_t(r[0]) == 0xFF) return (err = serverError(r)), false;
        if (!r.empty() && uint8_t(r[0]) != 0x00) {
            // result set (SELECT): skip until the final EOF / OK
            int eofs = 0;
            while (eofs < 2) {
                if (!readPacket(r, err)) return fail();
                if (!r.empty() && uint8_t(r[0]) == 0xFE && r.size() < 9) eofs++;
                if (!r.empty() && uint8_t(r[0]) == 0xFF) return (err = serverError(r)), false;
            }
        }
        return true;
    }

    bool prepare(const std::string& sql, size_t params, std::string& err) override {
        if (stmt_) {
            seq_ = 0;
            std::string c(1, char(0x19));  // COM_STMT_CLOSE (no response)
            le(c, stmt_, 4);
            writePacket(c, err);
            stmt_ = 0;
        }
        seq_ = 0;
        std::string q(1, char(0x16));
        q += sql;
        if (!writePacket(q, err)) return fail();
        std::string r;
        if (!readPacket(r, err)) return fail();
        if (!r.empty() && uint8_t(r[0]) == 0xFF) return (err = serverError(r)), false;
        if (r.size() < 12 || r[0] != 0) return (err = "malformed COM_STMT_PREPARE response"), fail();
        stmt_ = uint32_t(rdle(r, 1, 4));
        uint16_t columns = uint16_t(rdle(r, 5, 2));
        uint16_t nparams = uint16_t(rdle(r, 7, 2));
        params_ = params;
        if (nparams != params) return (err = "prepared statement: parameter count mismatch"), false;
        for (int block : {int(nparams), int(columns)}) {
            if (block == 0) continue;
            for (int k = 0; k <= block; k++)  // definitions + EOF
                if (!readPacket(r, err)) return fail();
        }
        return true;
    }

    bool execute(const std::vector<Value>& params, std::string& err) override {
        seq_ = 0;
        std::string q(1, char(0x17));
        le(q, stmt_, 4);
        q += char(0);    // flags: no cursor
        le(q, 1, 4);     // iteration count
        size_t n = params.size();
        std::string nulls((n + 7) / 8, '\0');
        for (size_t k = 0; k < n; k++)
            if (params[k].kind == Value::NUL) nulls[k / 8] = char(nulls[k / 8] | (1 << (k % 8)));
        q += nulls;
        q += char(1);    // new parameters bound
        std::string types, values;
        for (const Value& v : params) {
            switch (v.kind) {
                case Value::BOOL: types += char(0x01); types += char(0); values += char(v.i ? 1 : 0); break;          // TINY
                case Value::INT: types += char(0x08); types += char(0); le(values, uint64_t(v.i), 8); break;            // LONGLONG
                case Value::REAL: {
                    types += char(0x05); types += char(0);                                                             // DOUBLE
                    uint64_t bits;
                    memcpy(&bits, &v.d, 8);
                    le(values, bits, 8);
                    break;
                }
                case Value::TEXT: types += char(0xFD); types += char(0); lenenc(values, v.s.size()); values += v.s; break;  // VAR_STRING
                default: types += char(0x06); types += char(0); break;                                                  // NULL
            }
        }
        q += types;
        q += values;
        if (!writePacket(q, err)) return fail();
        std::string r;
        if (!readPacket(r, err)) return fail();
        if (!r.empty() && uint8_t(r[0]) == 0xFF) return (err = serverError(r)), false;
        return true;
    }

    void close() override {
        if (s_.open() && open_) {
            std::string e;
            seq_ = 0;
            writePacket(std::string(1, char(0x01)), e);  // COM_QUIT
        }
        s_.close();
        open_ = false;
        stmt_ = 0;
    }
    bool connected() const override { return open_; }
    std::string ident(const std::string& name) const override { return "`" + name + "`"; }
    const char* sqlType(Value::Kind k) const override {
        switch (k) {
            case Value::BOOL: return "BOOLEAN";
            case Value::INT: return "BIGINT";
            case Value::REAL: return "DOUBLE";
            default: return "VARCHAR(1024)";
        }
    }
    std::string insertIgnore(const std::string& table, const std::vector<std::string>& columns) const override {
        std::string cols, marks;
        for (size_t k = 0; k < columns.size(); k++) {
            cols += (k ? ", " : "") + ident(columns[k]);
            marks += k ? ", ?" : "?";
        }
        return "INSERT IGNORE INTO " + ident(table) + " (" + cols + ") VALUES (" + marks + ")";
    }
    std::string timestampType() const override { return "DATETIME(3)"; }
    std::string timestampText(int64_t ns) const override { return utcText(ns); }

private:
    bool fail() {
        s_.close();
        open_ = false;
        stmt_ = 0;
        return false;
    }

    bool writePacket(const std::string& payload, std::string& err) {
        std::string h;
        le(h, payload.size(), 3);
        h += char(seq_++);
        return s_.write((h + payload).data(), payload.size() + 4, err);
    }

    bool readPacket(std::string& payload, std::string& err) {
        char h[4];
        if (!s_.readExact(h, 4, err)) return false;
        size_t len = size_t(uint8_t(h[0])) | (size_t(uint8_t(h[1])) << 8) | (size_t(uint8_t(h[2])) << 16);
        seq_ = uint8_t(h[3] + 1);
        payload.assign(len, '\0');
        return len == 0 || s_.readExact(&payload[0], len, err);
    }

    static std::string serverError(const std::string& r) {
        uint16_t code = r.size() >= 3 ? uint16_t(rdle(r, 1, 2)) : 0;
        size_t msg = r.size() > 3 && r[3] == '#' ? 9 : 3;
        return "MySQL: " + (msg < r.size() ? r.substr(msg) : std::string()) + " (" + std::to_string(code) + ")";
    }

    static std::string scrambleFor(const std::string& plugin, const std::string& password, const std::string& scramble) {
        if (password.empty()) return std::string();
        std::string s20 = scramble.substr(0, 20);
        if (plugin == "caching_sha2_password") {
            std::string h1 = sha256(password);
            return xorWith(h1, sha256(sha256(h1) + s20));
        }
        std::string h1 = sha1(password);  // mysql_native_password
        return xorWith(h1, sha1(s20 + sha1(h1)));
    }

    bool authResult(std::string plugin, const std::string& password, std::string scramble, std::string& err) {
        for (;;) {
            std::string r;
            if (!readPacket(r, err)) return false;
            if (r.empty()) return (err = "empty authentication packet"), false;
            uint8_t k = uint8_t(r[0]);
            if (k == 0x00) return true;
            if (k == 0xFF) return (err = serverError(r)), false;
            if (k == 0xFE) {  // authentication method switch
                size_t end = r.find('\0', 1);
                plugin = r.substr(1, end - 1);
                scramble = r.substr(end + 1);
                if (!scramble.empty() && scramble.back() == '\0') scramble.pop_back();
                if (plugin != "caching_sha2_password" && plugin != "mysql_native_password") return (err = "unsupported MySQL authentication '" + plugin + "'"), false;
                if (!writePacket(scrambleFor(plugin, password, scramble), err)) return false;
                continue;
            }
            if (k == 0x01 && r.size() >= 2) {  // caching_sha2_password: more data
                if (r[1] == 0x03) continue;     // fast authentication succeeded: OK follows
                if (r[1] == 0x04) {             // full authentication
                    std::string pw = password;
                    pw += '\0';
                    if (s_.tls()) {
                        if (!writePacket(pw, err)) return false;
                        continue;
                    }
                    // without TLS: the password is encrypted with the RSA public key of the server
                    if (!writePacket(std::string(1, char(0x02)), err) || !readPacket(r, err)) return false;
                    std::string pem = r.size() > 1 && r[0] == 0x01 ? r.substr(1) : r;
                    std::string enc;
                    if (!rsaEncrypt(pem, xorWith(pw, scramble.substr(0, 20)), enc, err)) return false;
                    if (!writePacket(enc, err)) return false;
                    continue;
                }
            }
            err = "unexpected MySQL authentication packet";
            return false;
        }
    }

    static bool rsaEncrypt(const std::string& pem, const std::string& data, std::string& out, std::string& err) {
        BIO* bio = BIO_new_mem_buf(pem.data(), int(pem.size()));
        EVP_PKEY* key = PEM_read_bio_PUBKEY(bio, nullptr, nullptr, nullptr);
        BIO_free(bio);
        if (!key) return (err = "invalid RSA public key from the MySQL server"), false;
        EVP_PKEY_CTX* ctx = EVP_PKEY_CTX_new(key, nullptr);
        size_t len = 0;
        bool ok = ctx && EVP_PKEY_encrypt_init(ctx) > 0 && EVP_PKEY_CTX_set_rsa_padding(ctx, RSA_PKCS1_OAEP_PADDING) > 0 &&
                  EVP_PKEY_encrypt(ctx, nullptr, &len, reinterpret_cast<const unsigned char*>(data.data()), data.size()) > 0;
        if (ok) {
            out.assign(len, '\0');
            ok = EVP_PKEY_encrypt(ctx, reinterpret_cast<unsigned char*>(&out[0]), &len, reinterpret_cast<const unsigned char*>(data.data()), data.size()) > 0;
            out.resize(len);
        }
        EVP_PKEY_CTX_free(ctx);
        EVP_PKEY_free(key);
        if (!ok) err = "RSA encryption of the password failed";
        return ok;
    }

    Stream s_;
    uint8_t seq_ = 0;
    bool open_ = false;
    uint32_t stmt_ = 0;
    size_t params_ = 0;
};

}  // namespace

std::unique_ptr<Client> makeMysql() { return std::make_unique<Mysql>(); }

}  // namespace vplc::db
