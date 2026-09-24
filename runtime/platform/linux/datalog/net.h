// TCP connection with optional TLS (OpenSSL), with timeouts: used by the database clients.
#pragma once
#include <openssl/ssl.h>

#include <cstdint>
#include <string>

namespace vplc::db {

enum class Tls : uint8_t { DISABLE = 0, REQUIRE = 1, VERIFY = 2 };

class Stream {
public:
    ~Stream() { close(); }
    bool connect(const std::string& host, uint16_t port, int timeoutMs, std::string& err);
    // Switches to TLS. VERIFY checks the certificate chain (system CAs, or VPLC_DB_CA_FILE) and the host name.
    bool startTls(const std::string& host, Tls mode, std::string& err);
    bool write(const void* data, size_t len, std::string& err);
    bool readExact(void* data, size_t len, std::string& err);
    void close();
    bool tls() const { return ssl_ != nullptr; }
    bool open() const { return fd_ >= 0; }
    int timeoutMs = 10000;

private:
    bool wait(bool forWrite, std::string& err);
    int fd_ = -1;
    SSL_CTX* ctx_ = nullptr;
    SSL* ssl_ = nullptr;
};

// Cryptographic helpers (OpenSSL)
std::string sha256(const std::string& data);          // raw 32 bytes
std::string sha1(const std::string& data);            // raw 20 bytes
std::string hmacSha256(const std::string& key, const std::string& data);
std::string md5Hex(const std::string& data);
std::string toHex(const std::string& raw);
std::string base64(const std::string& raw);
std::string unbase64(const std::string& text);
std::string randomBytes(size_t n);

}  // namespace vplc::db
