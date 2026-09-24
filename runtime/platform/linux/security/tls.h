// TLS for the device protocol (Studio <-> CPU), IEC 62443-3-3 SR 3.1 / SR 4.1.
//
// The certificate is self-signed with the identity key of the CPU (<data dir>/identity.pem,
// Ed25519, the key that signs the data logs and the audit trail): the Studio pins that
// public key at the first connection (its fingerprint is printed at startup), so no PKI
// is needed on the shop floor. The same port serves both: a client starting with a TLS
// ClientHello gets TLS, others the plain protocol (refused with --tls-required).
#pragma once

#include <openssl/ssl.h>

#include <string>

#include "datalog/net.h"

namespace vplc::sec {

class TlsServer {
public:
    ~TlsServer();
    bool init(const std::string& dataDir, const std::string& name, std::string& err);
    SSL* wrap(int fd);  // server session on an accepted socket (non-blocking handshake)
    bool ready() const { return ctx_ != nullptr; }
    // "3f9a 12c0 …": first 16 bytes of sha256(public key hex), as keyFingerprint() of the SDK
    const std::string& fingerprint() const { return fingerprint_; }

private:
    SSL_CTX* ctx_ = nullptr;
    db::Identity identity_;
    std::string fingerprint_;
};

}  // namespace vplc::sec
