#include "tls.h"

#include <openssl/err.h>
#include <openssl/x509.h>
#include <openssl/x509v3.h>

namespace vplc::sec {

TlsServer::~TlsServer() {
    if (ctx_) SSL_CTX_free(ctx_);
}

bool TlsServer::init(const std::string& dataDir, const std::string& name, std::string& err) {
    if (!identity_.load(dataDir + "/identity.pem", err)) return false;
    std::string hex = db::toHex(db::sha256(db::toHex(identity_.publicKey())));
    fingerprint_.clear();
    for (size_t k = 0; k < 32; k += 4) fingerprint_ += (k ? " " : "") + hex.substr(k, 4);

    // Self-signed certificate (regenerated at each start: only the key is pinned)
    X509* cert = X509_new();
    X509_set_version(cert, 2);
    ASN1_INTEGER_set(X509_get_serialNumber(cert), long(time(nullptr)));
    X509_gmtime_adj(X509_getm_notBefore(cert), -3600);
    X509_gmtime_adj(X509_getm_notAfter(cert), 20L * 365 * 24 * 3600);
    X509_set_pubkey(cert, identity_.key());
    X509_NAME* subject = X509_get_subject_name(cert);
    std::string cn = "VirtualPLC " + name;
    X509_NAME_add_entry_by_txt(subject, "CN", MBSTRING_UTF8, reinterpret_cast<const unsigned char*>(cn.c_str()), -1, -1, 0);
    X509_set_issuer_name(cert, subject);
    bool ok = X509_sign(cert, identity_.key(), nullptr) > 0;

    ctx_ = SSL_CTX_new(TLS_server_method());
    ok = ok && ctx_ && SSL_CTX_set_min_proto_version(ctx_, TLS1_2_VERSION) == 1 && SSL_CTX_use_certificate(ctx_, cert) == 1 &&
         SSL_CTX_use_PrivateKey(ctx_, identity_.key()) == 1 && SSL_CTX_check_private_key(ctx_) == 1;
    X509_free(cert);
    if (!ok) {
        char buf[200];
        ERR_error_string_n(ERR_get_error(), buf, sizeof buf);
        err = std::string("TLS: ") + buf;
        if (ctx_) SSL_CTX_free(ctx_);
        ctx_ = nullptr;
        return false;
    }
    SSL_CTX_set_mode(ctx_, SSL_MODE_ENABLE_PARTIAL_WRITE | SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER);
    SSL_CTX_set_options(ctx_, SSL_OP_NO_RENEGOTIATION | SSL_OP_NO_COMPRESSION);
    return true;
}

SSL* TlsServer::wrap(int fd) {
    if (!ctx_) return nullptr;
    SSL* ssl = SSL_new(ctx_);
    if (ssl) SSL_set_fd(ssl, fd);
    return ssl;
}

}  // namespace vplc::sec
