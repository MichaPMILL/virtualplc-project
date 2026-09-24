// PostgreSQL frontend/backend protocol v3 (https://www.postgresql.org/docs/current/protocol.html):
// startup, TLS (SSLRequest), authentication SCRAM-SHA-256 / MD5 / password (TLS only),
// simple queries and the extended protocol (Parse / Bind / Execute / Sync).
#include <openssl/evp.h>

#include <cstring>

#include "sql.h"

namespace vplc::db {

namespace {

void put32(std::string& s, uint32_t v) {
    s += char(v >> 24);
    s += char(v >> 16);
    s += char(v >> 8);
    s += char(v);
}
void put16(std::string& s, uint16_t v) {
    s += char(v >> 8);
    s += char(v);
}
uint32_t get32(const std::string& s, size_t at) {
    return (uint32_t(uint8_t(s[at])) << 24) | (uint32_t(uint8_t(s[at + 1])) << 16) | (uint32_t(uint8_t(s[at + 2])) << 8) | uint8_t(s[at + 3]);
}

class Postgres : public Client {
public:
    bool connect(const Config& c, const std::string& password, std::string& err) override {
        close();
        if (!s_.connect(c.host, c.port, c.timeoutMs, err)) return false;
        if (c.tls != Tls::DISABLE) {
            std::string req;
            put32(req, 8);
            put32(req, 80877103);  // SSLRequest
            char answer = 0;
            if (!s_.write(req.data(), req.size(), err) || !s_.readExact(&answer, 1, err)) return fail(err);
            if (answer != 'S') {
                err = "the PostgreSQL server does not accept TLS (use TLS = disable only on a trusted network)";
                return fail(err);
            }
            if (!s_.startTls(c.host, c.tls, err)) return fail(err);
        }
        std::string body;
        put32(body, 196608);  // protocol 3.0
        for (const auto& kv : {std::make_pair("user", c.user), std::make_pair("database", c.database),
                               std::make_pair("client_encoding", std::string("UTF8")), std::make_pair("application_name", std::string("VirtualPLC"))}) {
            body += kv.first;
            body += '\0';
            body += kv.second;
            body += '\0';
        }
        body += '\0';
        std::string msg;
        put32(msg, uint32_t(body.size() + 4));
        msg += body;
        if (!s_.write(msg.data(), msg.size(), err)) return fail(err);
        if (!authenticate(c, password, err)) return fail(err);
        // until ReadyForQuery
        for (;;) {
            char type;
            std::string m;
            if (!read(type, m, err)) return fail(err);
            if (type == 'E') return fail(err = serverError(m));
            if (type == 'Z') break;
        }
        open_ = true;
        return true;
    }

    bool exec(const std::string& sql, std::string& err) override {
        std::string body = sql;
        body += '\0';
        if (!send('Q', body, err)) return fail(err);
        std::string error;
        for (;;) {
            char type;
            std::string m;
            if (!read(type, m, err)) return fail(err);
            if (type == 'E') error = serverError(m);
            if (type == 'Z') break;
        }
        if (!error.empty()) {
            err = error;
            return false;
        }
        return true;
    }

    bool prepare(const std::string& sql, size_t params, std::string& err) override {
        // ? -> $1, $2...
        std::string q;
        size_t k = 0;
        for (char ch : sql) {
            if (ch == '?') q += "$" + std::to_string(++k);
            else q += ch;
        }
        params_ = params;
        std::string body;
        body += "vplc_insert";
        body += '\0';
        body += q;
        body += '\0';
        put16(body, 0);  // parameter types inferred by the server
        std::string close;
        close += 'S';
        close += "vplc_insert";
        close += '\0';
        if (!send('C', close, err) || !send('P', body, err) || !send('S', std::string(), err)) return fail(err);
        return drain(err);
    }

    bool execute(const std::vector<Value>& params, std::string& err) override {
        std::string body;
        body += '\0';  // unnamed portal
        body += "vplc_insert";
        body += '\0';
        put16(body, 0);  // all parameters in text format
        put16(body, uint16_t(params.size()));
        for (const Value& v : params) {
            if (v.kind == Value::NUL) {
                put32(body, 0xFFFFFFFFu);
            } else {
                std::string t = v.kind == Value::BOOL ? (v.i ? "true" : "false") : v.text();
                put32(body, uint32_t(t.size()));
                body += t;
            }
        }
        put16(body, 0);  // result formats
        std::string exec;
        exec += '\0';
        put32(exec, 0);
        if (!send('B', body, err) || !send('E', exec, err) || !send('S', std::string(), err)) return fail(err);
        return drain(err);
    }

    void close() override {
        if (s_.open()) {
            std::string e;
            send('X', std::string(), e);
        }
        s_.close();
        open_ = false;
    }
    bool connected() const override { return open_; }
    std::string ident(const std::string& name) const override { return "\"" + name + "\""; }
    const char* sqlType(Value::Kind k) const override {
        switch (k) {
            case Value::BOOL: return "BOOLEAN";
            case Value::INT: return "BIGINT";
            case Value::REAL: return "DOUBLE PRECISION";
            default: return "TEXT";
        }
    }
    std::string insertIgnore(const std::string& table, const std::vector<std::string>& columns) const override {
        std::string cols, marks;
        for (size_t k = 0; k < columns.size(); k++) {
            cols += (k ? ", " : "") + ident(columns[k]);
            marks += k ? ", ?" : "?";
        }
        return "INSERT INTO " + ident(table) + " (" + cols + ") VALUES (" + marks + ") ON CONFLICT DO NOTHING";
    }
    std::string timestampType() const override { return "TIMESTAMPTZ"; }
    std::string timestampText(int64_t ns) const override { return utcText(ns) + "+00"; }

private:
    bool fail(std::string& err) {
        (void)err;
        s_.close();
        open_ = false;
        return false;
    }

    bool send(char type, const std::string& body, std::string& err) {
        std::string m;
        m += type;
        put32(m, uint32_t(body.size() + 4));
        m += body;
        return s_.write(m.data(), m.size(), err);
    }

    bool read(char& type, std::string& body, std::string& err) {
        char h[5];
        if (!s_.readExact(h, 5, err)) return false;
        type = h[0];
        uint32_t len = get32(std::string(h + 1, 4), 0);
        if (len < 4 || len > (64u << 20)) {
            err = "malformed PostgreSQL message";
            return false;
        }
        body.assign(len - 4, '\0');
        return len == 4 || s_.readExact(&body[0], len - 4, err);
    }

    // Reads until ReadyForQuery; reports the first error
    bool drain(std::string& err) {
        std::string error;
        for (;;) {
            char type;
            std::string m;
            if (!read(type, m, err)) return fail(err);
            if (type == 'E' && error.empty()) error = serverError(m);
            if (type == 'Z') break;
        }
        if (!error.empty()) {
            err = error;
            return false;
        }
        return true;
    }

    static std::string serverError(const std::string& m) {
        std::string code, message;
        for (size_t i = 0; i < m.size() && m[i];) {
            char f = m[i++];
            size_t end = m.find('\0', i);
            if (end == std::string::npos) break;
            if (f == 'C') code = m.substr(i, end - i);
            if (f == 'M') message = m.substr(i, end - i);
            i = end + 1;
        }
        return "PostgreSQL: " + message + (code.empty() ? "" : " (" + code + ")");
    }

    bool authenticate(const Config& c, const std::string& password, std::string& err) {
        for (;;) {
            char type;
            std::string m;
            if (!read(type, m, err)) return false;
            if (type == 'E') {
                err = serverError(m);
                return false;
            }
            if (type != 'R' || m.size() < 4) {
                err = "unexpected PostgreSQL message during authentication";
                return false;
            }
            uint32_t kind = get32(m, 0);
            if (kind == 0) return true;  // AuthenticationOk
            if (kind == 3) {             // cleartext password
                if (!s_.tls()) {
                    err = "the server asks for a clear-text password without TLS: refused";
                    return false;
                }
                std::string body = password;
                body += '\0';
                if (!send('p', body, err)) return false;
            } else if (kind == 5) {      // MD5
                std::string salt = m.substr(4, 4);
                std::string body = "md5" + md5Hex(md5Hex(password + c.user) + salt);
                body += '\0';
                if (!send('p', body, err)) return false;
            } else if (kind == 10) {     // SASL
                if (m.find("SCRAM-SHA-256") == std::string::npos) {
                    err = "no supported SASL mechanism (SCRAM-SHA-256 expected)";
                    return false;
                }
                if (!scram(password, err)) return false;
            } else {
                err = "unsupported PostgreSQL authentication method " + std::to_string(kind);
                return false;
            }
        }
    }

    bool scram(const std::string& password, std::string& err) {
        std::string nonce = base64(randomBytes(18));
        std::string first = "n=,r=" + nonce;
        std::string body = "SCRAM-SHA-256";
        body += '\0';
        std::string data = "n,," + first;
        put32(body, uint32_t(data.size()));
        body += data;
        if (!send('p', body, err)) return false;
        char type;
        std::string m;
        if (!read(type, m, err)) return false;
        if (type == 'E') return (err = serverError(m)), false;
        if (type != 'R' || m.size() < 4 || get32(m, 0) != 11) return (err = "SCRAM: unexpected message"), false;
        std::string serverFirst = m.substr(4);
        std::string r, s;
        int iterations = 0;
        size_t pos = 0;
        while (pos < serverFirst.size()) {
            size_t end = serverFirst.find(',', pos);
            if (end == std::string::npos) end = serverFirst.size();
            std::string part = serverFirst.substr(pos, end - pos);
            if (part.rfind("r=", 0) == 0) r = part.substr(2);
            if (part.rfind("s=", 0) == 0) s = part.substr(2);
            if (part.rfind("i=", 0) == 0) iterations = atoi(part.c_str() + 2);
            pos = end + 1;
        }
        if (r.rfind(nonce, 0) != 0 || s.empty() || iterations < 1) return (err = "SCRAM: invalid server challenge"), false;
        std::string salt = unbase64(s);
        unsigned char salted[32];
        PKCS5_PBKDF2_HMAC(password.data(), int(password.size()), reinterpret_cast<const unsigned char*>(salt.data()), int(salt.size()),
                          iterations, EVP_sha256(), 32, salted);
        std::string saltedPassword(reinterpret_cast<char*>(salted), 32);
        std::string clientKey = hmacSha256(saltedPassword, "Client Key");
        std::string storedKey = sha256(clientKey);
        std::string finalBare = "c=biws,r=" + r;
        std::string authMessage = first + "," + serverFirst + "," + finalBare;
        std::string signature = hmacSha256(storedKey, authMessage);
        std::string proof = clientKey;
        for (size_t k = 0; k < proof.size(); k++) proof[k] = char(proof[k] ^ signature[k]);
        std::string final = finalBare + ",p=" + base64(proof);
        if (!send('p', final, err)) return false;
        if (!read(type, m, err)) return false;
        if (type == 'E') return (err = serverError(m)), false;
        if (type != 'R' || m.size() < 4 || get32(m, 0) != 12) return (err = "SCRAM: unexpected final message"), false;
        std::string serverKey = hmacSha256(saltedPassword, "Server Key");
        std::string expected = "v=" + base64(hmacSha256(serverKey, authMessage));
        if (m.substr(4).rfind(expected, 0) != 0) return (err = "SCRAM: the server signature is wrong (possible impostor)"), false;
        memset(salted, 0, sizeof salted);
        return true;
    }

    Stream s_;
    bool open_ = false;
    size_t params_ = 0;
};

}  // namespace

std::unique_ptr<Client> makePostgres() { return std::make_unique<Postgres>(); }

}  // namespace vplc::db
