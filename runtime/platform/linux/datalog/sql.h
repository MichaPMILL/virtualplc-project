// Database clients for the traceability data logs: PostgreSQL and MySQL / MariaDB, written
// from the public protocol documentations (no client library). Values are always sent as
// parameters of prepared statements: no SQL injection through PLC strings.
#pragma once
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "net.h"

namespace vplc::db {

struct Value {
    enum Kind : uint8_t { NUL, BOOL, INT, REAL, TEXT };
    Kind kind = NUL;
    int64_t i = 0;
    double d = 0;
    std::string s;
    // Text form of a parameter (numbers, raw string)
    std::string text() const;
};

struct Config {
    std::string host;
    uint16_t port = 0;
    std::string database, user;
    Tls tls = Tls::VERIFY;
    int timeoutMs = 10000;
};

class Client {
public:
    virtual ~Client() = default;
    virtual bool connect(const Config& c, const std::string& password, std::string& err) = 0;
    // Statement without parameters (DDL, BEGIN, COMMIT)
    virtual bool exec(const std::string& sql, std::string& err) = 0;
    // Prepared statement with ? placeholders (converted for each server), then executions
    virtual bool prepare(const std::string& sql, size_t params, std::string& err) = 0;
    virtual bool execute(const std::vector<Value>& params, std::string& err) = 0;
    virtual void close() = 0;
    virtual bool connected() const = 0;
    // Quoted identifier ("name" / `name`); names are validated by the compiler ([A-Za-z_][A-Za-z0-9_]*)
    virtual std::string ident(const std::string& name) const = 0;
    // SQL type of a column
    virtual const char* sqlType(Value::Kind k) const = 0;
    // "INSERT ... ON CONFLICT DO NOTHING" or "INSERT IGNORE ..."
    virtual std::string insertIgnore(const std::string& table, const std::vector<std::string>& columns) const = 0;
    // Column type and parameter text of the record time (UTC)
    virtual std::string timestampType() const = 0;
    virtual std::string timestampText(int64_t ns) const = 0;
};

// "YYYY-MM-DD HH:MM:SS.mmm" (UTC)
std::string utcText(int64_t ns);

std::unique_ptr<Client> makePostgres();
std::unique_ptr<Client> makeMysql();

}  // namespace vplc::db
