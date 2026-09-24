#include "net.h"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
#include <openssl/x509v3.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <cstdlib>
#include <cstring>

namespace vplc::db {

namespace {
std::string sslError(const char* what) {
    unsigned long e = ERR_get_error();
    char buf[256];
    ERR_error_string_n(e, buf, sizeof buf);
    return std::string(what) + (e ? std::string(": ") + buf : std::string());
}
}  // namespace

bool Stream::connect(const std::string& host, uint16_t port, int timeoutMs, std::string& err) {
    close();
    timeoutMs = timeoutMs > 0 ? timeoutMs : 10000;
    this->timeoutMs = timeoutMs;
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* res = nullptr;
    std::string service = std::to_string(port);
    int rc = getaddrinfo(host.c_str(), service.c_str(), &hints, &res);
    if (rc != 0) {
        err = "cannot resolve " + host + ": " + gai_strerror(rc);
        return false;
    }
    err = "cannot connect to " + host + ":" + service;
    for (addrinfo* a = res; a; a = a->ai_next) {
        int fd = ::socket(a->ai_family, a->ai_socktype | SOCK_CLOEXEC, a->ai_protocol);
        if (fd < 0) continue;
        fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
        rc = ::connect(fd, a->ai_addr, a->ai_addrlen);
        if (rc < 0 && errno == EINPROGRESS) {
            pollfd p{fd, POLLOUT, 0};
            rc = poll(&p, 1, timeoutMs) == 1 ? 0 : -1;
            int so = 0;
            socklen_t sl = sizeof so;
            if (rc == 0 && (getsockopt(fd, SOL_SOCKET, SO_ERROR, &so, &sl) < 0 || so != 0)) {
                errno = so;
                rc = -1;
            }
            if (rc < 0 && errno == 0) errno = ETIMEDOUT;
        }
        if (rc == 0) {
            int one = 1;
            setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
            fd_ = fd;
            break;
        }
        err = "cannot connect to " + host + ":" + service + ": " + strerror(errno);
        ::close(fd);
    }
    freeaddrinfo(res);
    return fd_ >= 0;
}

bool Stream::wait(bool forWrite, std::string& err) {
    pollfd p{fd_, short(forWrite ? POLLOUT : POLLIN), 0};
    int rc = poll(&p, 1, timeoutMs);
    if (rc == 1) return true;
    err = rc == 0 ? "timeout" : std::string("poll: ") + strerror(errno);
    return false;
}

bool Stream::startTls(const std::string& host, Tls mode, std::string& err) {
    ctx_ = SSL_CTX_new(TLS_client_method());
    if (!ctx_) {
        err = sslError("TLS");
        return false;
    }
    SSL_CTX_set_min_proto_version(ctx_, TLS1_2_VERSION);
    if (mode == Tls::VERIFY) {
        const char* ca = getenv("VPLC_DB_CA_FILE");
        if (ca && *ca ? SSL_CTX_load_verify_locations(ctx_, ca, nullptr) != 1 : SSL_CTX_set_default_verify_paths(ctx_) != 1) {
            err = sslError("TLS: cannot load the trusted certificates");
            return false;
        }
        SSL_CTX_set_verify(ctx_, SSL_VERIFY_PEER, nullptr);
    } else {
        SSL_CTX_set_verify(ctx_, SSL_VERIFY_NONE, nullptr);
    }
    ssl_ = SSL_new(ctx_);
    SSL_set_fd(ssl_, fd_);
    SSL_set_tlsext_host_name(ssl_, host.c_str());
    if (mode == Tls::VERIFY) SSL_set1_host(ssl_, host.c_str());
    for (;;) {
        int rc = SSL_connect(ssl_);
        if (rc == 1) return true;
        int e = SSL_get_error(ssl_, rc);
        if (e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) {
            if (!wait(e == SSL_ERROR_WANT_WRITE, err)) return false;
            continue;
        }
        long v = SSL_get_verify_result(ssl_);
        err = v != X509_V_OK ? std::string("TLS: certificate rejected: ") + X509_verify_cert_error_string(v) : sslError("TLS handshake failed");
        SSL_free(ssl_);
        ssl_ = nullptr;
        return false;
    }
}

bool Stream::write(const void* data, size_t len, std::string& err) {
    const uint8_t* p = static_cast<const uint8_t*>(data);
    while (len > 0) {
        if (ssl_) {
            int rc = SSL_write(ssl_, p, int(len));
            if (rc <= 0) {
                int e = SSL_get_error(ssl_, rc);
                if ((e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) && wait(e == SSL_ERROR_WANT_WRITE, err)) continue;
                if (err.empty()) err = sslError("TLS write");
                return false;
            }
            p += rc;
            len -= size_t(rc);
        } else {
            ssize_t rc = ::send(fd_, p, len, MSG_NOSIGNAL);
            if (rc < 0) {
                if ((errno == EAGAIN || errno == EWOULDBLOCK) && wait(true, err)) continue;
                if (err.empty()) err = std::string("send: ") + strerror(errno);
                return false;
            }
            p += rc;
            len -= size_t(rc);
        }
    }
    return true;
}

bool Stream::readExact(void* data, size_t len, std::string& err) {
    uint8_t* p = static_cast<uint8_t*>(data);
    while (len > 0) {
        if (ssl_) {
            int rc = SSL_read(ssl_, p, int(len));
            if (rc <= 0) {
                int e = SSL_get_error(ssl_, rc);
                if ((e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) && wait(e == SSL_ERROR_WANT_WRITE, err)) continue;
                if (err.empty()) err = e == SSL_ERROR_ZERO_RETURN ? "connection closed by the server" : sslError("TLS read");
                return false;
            }
            p += rc;
            len -= size_t(rc);
        } else {
            ssize_t rc = ::recv(fd_, p, len, 0);
            if (rc < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                if (!wait(false, err)) return false;
                continue;
            }
            if (rc <= 0) {
                err = rc == 0 ? "connection closed by the server" : std::string("recv: ") + strerror(errno);
                return false;
            }
            p += rc;
            len -= size_t(rc);
        }
    }
    return true;
}

void Stream::close() {
    if (ssl_) {
        SSL_shutdown(ssl_);
        SSL_free(ssl_);
        ssl_ = nullptr;
    }
    if (ctx_) {
        SSL_CTX_free(ctx_);
        ctx_ = nullptr;
    }
    if (fd_ >= 0) {
        ::close(fd_);
        fd_ = -1;
    }
}

std::string sha256(const std::string& data) {
    unsigned char out[32];
    unsigned int n = 0;
    EVP_Digest(data.data(), data.size(), out, &n, EVP_sha256(), nullptr);
    return std::string(reinterpret_cast<char*>(out), n);
}

std::string sha1(const std::string& data) {
    unsigned char out[20];
    unsigned int n = 0;
    EVP_Digest(data.data(), data.size(), out, &n, EVP_sha1(), nullptr);
    return std::string(reinterpret_cast<char*>(out), n);
}

std::string hmacSha256(const std::string& key, const std::string& data) {
    unsigned char out[32];
    unsigned int n = 0;
    HMAC(EVP_sha256(), key.data(), int(key.size()), reinterpret_cast<const unsigned char*>(data.data()), data.size(), out, &n);
    return std::string(reinterpret_cast<char*>(out), n);
}

std::string md5Hex(const std::string& data) {
    unsigned char out[16];
    unsigned int n = 0;
    EVP_Digest(data.data(), data.size(), out, &n, EVP_md5(), nullptr);
    return toHex(std::string(reinterpret_cast<char*>(out), n));
}

std::string toHex(const std::string& raw) {
    static const char* d = "0123456789abcdef";
    std::string s;
    s.reserve(raw.size() * 2);
    for (unsigned char c : raw) {
        s += d[c >> 4];
        s += d[c & 15];
    }
    return s;
}

std::string base64(const std::string& raw) {
    std::string out(4 * ((raw.size() + 2) / 3) + 1, '\0');
    int n = EVP_EncodeBlock(reinterpret_cast<unsigned char*>(&out[0]), reinterpret_cast<const unsigned char*>(raw.data()), int(raw.size()));
    out.resize(size_t(n));
    return out;
}

std::string unbase64(const std::string& text) {
    std::string out(3 * (text.size() / 4) + 3, '\0');
    int n = EVP_DecodeBlock(reinterpret_cast<unsigned char*>(&out[0]), reinterpret_cast<const unsigned char*>(text.data()), int(text.size()));
    if (n < 0) return std::string();
    size_t pad = 0;
    if (!text.empty() && text.back() == '=') pad++;
    if (text.size() > 1 && text[text.size() - 2] == '=') pad++;
    out.resize(size_t(n) - pad);
    return out;
}

std::string randomBytes(size_t n) {
    std::string out(n, '\0');
    RAND_bytes(reinterpret_cast<unsigned char*>(&out[0]), int(n));
    return out;
}

}  // namespace vplc::db
