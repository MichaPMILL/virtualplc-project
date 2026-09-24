#include "datalog.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <chrono>
#include <cinttypes>
#include <cmath>
#include <cstring>
#include <ctime>
#include <fstream>
#include <sstream>

#include "bytes.h"
#include "isa.h"

namespace vplc {

using db::Value;

namespace db {

std::string Value::text() const {
    char buf[40];
    switch (kind) {
        case BOOL: return i ? "1" : "0";
        case INT: snprintf(buf, sizeof buf, "%" PRId64, i); return buf;
        case REAL: snprintf(buf, sizeof buf, "%.17g", d); return buf;
        case TEXT: return s;
        default: return std::string();
    }
}

std::string utcText(int64_t ns) {
    time_t secs = time_t(ns / 1000000000LL);
    int ms = int((ns / 1000000LL) % 1000);
    if (ms < 0) ms += 1000;
    tm t{};
    gmtime_r(&secs, &t);
    char buf[40];
    snprintf(buf, sizeof buf, "%04d-%02d-%02d %02d:%02d:%02d.%03d", t.tm_year + 1900, t.tm_mon + 1, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec, ms);
    return buf;
}

}  // namespace db

namespace {

int64_t nowNs() {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string q(const std::string& id) { return "\"" + id + "\""; }

std::string jsonString(const std::string& s) {
    std::string o = "\"";
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += char(c); }
        else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += char(c);
    }
    return o + "\"";
}

std::string jsonValue(const Value& v) {
    switch (v.kind) {
        case Value::BOOL: return v.i ? "true" : "false";
        case Value::INT: return v.text();
        case Value::REAL: return std::isfinite(v.d) ? v.text() : "null";
        case Value::TEXT: return jsonString(v.s);
        default: return "null";
    }
}

bool run(sqlite3* db, const std::string& sql, std::string& err) {
    char* e = nullptr;
    if (sqlite3_exec(db, sql.c_str(), nullptr, nullptr, &e) == SQLITE_OK) return true;
    err = std::string("SQLite: ") + (e ? e : "error");
    sqlite3_free(e);
    return false;
}

Value columnValue(sqlite3_stmt* st, int i, Value::Kind kind) {
    Value v;
    switch (sqlite3_column_type(st, i)) {
        case SQLITE_NULL: return v;
        case SQLITE_INTEGER: v.kind = kind == Value::BOOL ? Value::BOOL : Value::INT; v.i = sqlite3_column_int64(st, i); break;
        case SQLITE_FLOAT: v.kind = Value::REAL; v.d = sqlite3_column_double(st, i); break;
        default: {
            v.kind = Value::TEXT;
            const unsigned char* t = sqlite3_column_text(st, i);
            v.s.assign(reinterpret_cast<const char*>(t ? t : reinterpret_cast<const unsigned char*>("")), size_t(sqlite3_column_bytes(st, i)));
        }
    }
    return v;
}

}  // namespace

// ---------------------------------------------------------------------------
// Hash chain (docs/traceability.md): chain(n) = SHA-256(chain(n-1) "|" canonical(n)), hex
// ---------------------------------------------------------------------------

std::string DataLogger::canonical(int64_t recordId, int64_t timeNs, const std::vector<Value>& values) {
    std::string s = std::to_string(recordId) + "|" + std::to_string(timeNs);
    for (const Value& v : values) {
        s += '|';
        switch (v.kind) {
            case Value::BOOL: s += v.i ? "B1" : "B0"; break;
            case Value::INT: s += "I" + std::to_string(v.i); break;
            case Value::REAL: {
                uint64_t bits;
                memcpy(&bits, &v.d, 8);
                char b[24];
                snprintf(b, sizeof b, "R%016" PRIx64, bits);
                s += b;
                break;
            }
            case Value::TEXT: s += "T" + std::to_string(v.s.size()) + ":" + v.s; break;
            default: s += "N";
        }
    }
    return s;
}

std::string DataLogger::genesis(const std::string& plc, const std::string& log, int64_t epoch) {
    return db::toHex(db::sha256("VirtualPLC data log|" + plc + "|" + log + "|" + std::to_string(epoch)));
}

std::string DataLogger::chain(const std::string& previous, const std::string& canonical) {
    return db::toHex(db::sha256(previous + "|" + canonical));
}

// ---------------------------------------------------------------------------

DataLogger::DataLogger(std::string dir, std::function<void(const std::string&)> note) : dir_(std::move(dir)), note_(std::move(note)) {
    loadSecrets();
}

DataLogger::~DataLogger() {
    stop();
    if (reader_) sqlite3_close(reader_);
    if (db_) sqlite3_close(db_);
}

void DataLogger::stop() {
    if (!running_) return;
    running_ = false;
    queueCv_.notify_all();
    forwardCv_.notify_all();
    if (writer_.joinable()) writer_.join();
    for (auto& l : logs_)
        if (l->forwarder.joinable()) l->forwarder.join();
}

bool DataLogger::openLocal(std::string& err) {
    if (db_) return true;
    mkdir(dir_.c_str(), 0750);
    std::string path = dir_ + "/traceability.db";
    if (sqlite3_open_v2(path.c_str(), &db_, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nullptr) != SQLITE_OK) {
        err = "cannot open " + path + ": " + sqlite3_errmsg(db_);
        sqlite3_close(db_);
        db_ = nullptr;
        return false;
    }
    chmod(path.c_str(), 0640);
    sqlite3_busy_timeout(db_, 5000);
    if (!run(db_, "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; "
                  "CREATE TABLE IF NOT EXISTS vplc_logs (name TEXT PRIMARY KEY, schema TEXT NOT NULL, epoch INTEGER NOT NULL, last_chain TEXT NOT NULL)", err)) {
        return false;
    }
    sqlite3_open_v2(path.c_str(), &reader_, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nullptr);
    sqlite3_busy_timeout(reader_, 2000);
    return true;
}

bool DataLogger::configure(const Program& program, const std::string& plcName) {
    stop();
    logs_.clear();
    {
        std::lock_guard<std::mutex> lock(queueMutex_);
        queue_.clear();
    }
    plc_ = plcName;
    if (program.datalogs.size == 0) return true;
    std::string err;
    if (!openLocal(err)) {
        note_("Traceability: " + err);
        return false;
    }
    DataLogReader reader(program.datalogs);
    DataLogInfo info;
    while (reader.next(info)) {
        auto log = std::make_unique<Log>();
        log->name = info.name;
        log->table = std::string("log_") + info.name;
        log->retentionDays = info.retentionDays;
        uint8_t pos = 0;
        const uint8_t* cursor = nullptr;
        DataLogColumn c;
        while (info.column(pos, cursor, c)) {
            Column col;
            col.name = c.name;
            col.type = c.type;
            col.bit = c.bit;
            col.size = c.size;
            if (c.bit != 0xFF || c.type == uint8_t(VmType::T_BOOL)) col.kind = Value::BOOL;
            else if (c.type == 0x20) col.kind = Value::TEXT;
            else if (c.type == uint8_t(VmType::T_F32) || c.type == uint8_t(VmType::T_F64)) col.kind = Value::REAL;
            else col.kind = Value::INT;
            log->columns.push_back(col);
        }
        log->dbKind = info.dbKind;
        if (info.dbKind != DataLogInfo::NONE) {
            log->db.host = info.host;
            log->db.port = info.port;
            log->db.database = info.database;
            log->db.user = info.user;
            log->db.tls = db::Tls(info.tls);
            log->remoteTable = info.table;
            log->secretKey = std::string(info.dbKind == DataLogInfo::POSTGRESQL ? "postgresql" : "mysql") + "://" + info.user + "@" +
                             info.host + ":" + std::to_string(info.port) + "/" + info.database;
        }
        if (!prepareLocal(*log, err)) {
            note_("Traceability: data log '" + log->name + "': " + err);
            return false;
        }
        logs_.push_back(std::move(log));
    }
    running_ = true;
    writer_ = std::thread([this] { writer(); });
    for (auto& l : logs_) {
        Log* p = l.get();
        if (p->dbKind != DataLogInfo::NONE) p->forwarder = std::thread([this, p] { forward(p); });
    }
    note_("Traceability: " + std::to_string(logs_.size()) + " data log(s), local database " + dir_ + "/traceability.db");
    return true;
}

// The local table of a log; a table with other columns is archived (renamed) and a new chain starts
bool DataLogger::prepareLocal(Log& log, std::string& err) {
    std::string schema;
    for (const Column& c : log.columns) schema += c.name + ":" + std::to_string(int(c.kind)) + ",";
    sqlite3_stmt* st = nullptr;
    sqlite3_prepare_v2(db_, "SELECT schema, epoch, last_chain FROM vplc_logs WHERE name = ?", -1, &st, nullptr);
    sqlite3_bind_text(st, 1, log.name.c_str(), -1, SQLITE_TRANSIENT);
    bool exists = sqlite3_step(st) == SQLITE_ROW;
    std::string oldSchema = exists ? reinterpret_cast<const char*>(sqlite3_column_text(st, 0)) : "";
    int64_t oldEpoch = exists ? sqlite3_column_int64(st, 1) : 0;
    std::string oldChain = exists ? reinterpret_cast<const char*>(sqlite3_column_text(st, 2)) : "";
    sqlite3_finalize(st);
    if (exists && oldSchema == schema) {
        log.epoch = oldEpoch;
        log.lastChain = oldChain;
        return true;
    }
    if (exists) {
        std::string archive = log.table + "_" + std::to_string(oldEpoch);
        if (!run(db_, "ALTER TABLE " + q(log.table) + " RENAME TO " + q(archive), err)) return false;
        note_("Traceability: the columns of data log '" + log.name + "' changed: previous records kept in table " + archive);
    }
    log.epoch = nowNs() / 1000000000LL;
    log.lastChain = genesis(plc_, log.name, log.epoch);
    std::string cols, guarded;
    for (const Column& c : log.columns) {
        cols += ", " + q(c.name) + (c.kind == Value::REAL ? " REAL" : c.kind == Value::TEXT ? " TEXT" : " INTEGER");
        guarded += ", " + q(c.name);
    }
    std::string trigger = log.table + "_" + std::to_string(log.epoch) + "_immutable";
    std::string sql = "BEGIN; CREATE TABLE " + q(log.table) + " (id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ns INTEGER NOT NULL" + cols +
                      ", chain TEXT NOT NULL, synced INTEGER NOT NULL DEFAULT 0);"
                      "CREATE INDEX " + q(log.table + "_" + std::to_string(log.epoch) + "_pending") + " ON " + q(log.table) + " (synced, id);"
                      // records are written once: only the forwarding flag may change
                      "CREATE TRIGGER " + q(trigger) + " BEFORE UPDATE OF ts_ns, chain" + guarded + " ON " + q(log.table) +
                      " BEGIN SELECT RAISE(ABORT, 'traceability records are immutable'); END;";
    sql += "INSERT OR REPLACE INTO vplc_logs (name, schema, epoch, last_chain) VALUES ('" + log.name + "', '" + schema + "', " +
           std::to_string(log.epoch) + ", '" + log.lastChain + "'); COMMIT;";
    if (!run(db_, sql, err)) {
        std::string e2;
        run(db_, "ROLLBACK", e2);
        return false;
    }
    return true;
}

std::vector<Value> DataLogger::decode(const Log& log, const uint8_t* p, uint32_t length) const {
    std::vector<Value> out;
    uint32_t at = 0;
    for (const Column& c : log.columns) {
        Value v;
        uint32_t n = c.bit != 0xFF ? 1 : c.size;
        if (at + n > length) break;
        const uint8_t* b = p + at;
        at += n;
        v.kind = c.kind;
        if (c.bit != 0xFF) {
            v.i = b[0] ? 1 : 0;
        } else if (c.type == 0x20) {  // STRING: max length, length, characters
            uint8_t len = n >= 2 ? b[1] : 0;
            if (len > n - 2) len = uint8_t(n - 2);
            v.s.assign(reinterpret_cast<const char*>(b + 2), len);
        } else if (c.type == 0x21) {  // TIME (ms)
            v.i = int32_t(uint32_t(rdbe(b, 4)));
        } else {
            switch (VmType(c.type)) {
                case VmType::T_BOOL: v.i = b[0] ? 1 : 0; break;
                case VmType::T_U8: v.i = b[0]; break;
                case VmType::T_I8: v.i = int8_t(b[0]); break;
                case VmType::T_U16: v.i = uint16_t(rdbe(b, 2)); break;
                case VmType::T_I16: v.i = int16_t(uint16_t(rdbe(b, 2))); break;
                case VmType::T_U32: v.i = uint32_t(rdbe(b, 4)); break;
                case VmType::T_I32: v.i = int32_t(uint32_t(rdbe(b, 4))); break;
                case VmType::T_I64:
                case VmType::T_U64: v.i = int64_t(rdbe(b, 8)); break;
                case VmType::T_F32: {
                    uint32_t bits = uint32_t(rdbe(b, 4));
                    float f;
                    memcpy(&f, &bits, 4);
                    v.d = f;
                    break;
                }
                case VmType::T_F64: {
                    uint64_t bits = rdbe(b, 8);
                    memcpy(&v.d, &bits, 8);
                    break;
                }
                default: v.kind = Value::NUL;
            }
        }
        out.push_back(std::move(v));
    }
    return out;
}

bool DataLogger::push(uint16_t log, int64_t timeNs, const uint8_t* values, uint32_t length) {
    if (!running_ || log >= logs_.size()) return false;
    {
        std::lock_guard<std::mutex> lock(queueMutex_);
        if (queue_.size() >= MAX_QUEUE) {
            dropped_++;
            return false;
        }
        queue_.push_back(Record{log, timeNs ? timeNs : nowNs(), std::vector<uint8_t>(values, values + length)});
    }
    queueCv_.notify_one();
    return true;
}

// ---------------------------------------------------------------------------
// Local writer
// ---------------------------------------------------------------------------

void DataLogger::writer() {
    auto nextRetention = std::chrono::steady_clock::now();
    while (running_) {
        std::deque<Record> batch;
        {
            std::unique_lock<std::mutex> lock(queueMutex_);
            queueCv_.wait_for(lock, std::chrono::milliseconds(200), [this] { return !queue_.empty() || !running_; });
            batch.swap(queue_);
        }
        if (!batch.empty()) writeBatch(batch);
        if (std::chrono::steady_clock::now() >= nextRetention) {
            retention();
            nextRetention = std::chrono::steady_clock::now() + std::chrono::hours(1);
        }
    }
    std::deque<Record> rest;
    {
        std::lock_guard<std::mutex> lock(queueMutex_);
        rest.swap(queue_);
    }
    if (!rest.empty()) writeBatch(rest);  // nothing queued is lost when a program is loaded
}

void DataLogger::writeBatch(std::deque<Record>& batch) {
    std::string err;
    if (!run(db_, "BEGIN IMMEDIATE", err)) {
        note_("Traceability: " + err);
        return;
    }
    std::vector<std::string> chains(logs_.size());
    for (size_t k = 0; k < logs_.size(); k++) chains[k] = logs_[k]->lastChain;
    bool ok = true;
    for (Record& r : batch) {
        Log& log = *logs_[r.log];
        std::vector<Value> values = decode(log, r.values.data(), uint32_t(r.values.size()));
        std::string cols, marks;
        for (const Column& c : log.columns) {
            cols += ", " + q(c.name);
            marks += ", ?";
        }
        // id first (the chain covers it): next id of the AUTOINCREMENT table
        sqlite3_stmt* st = nullptr;
        std::string sql = "INSERT INTO " + q(log.table) + " (ts_ns" + cols + ", chain) VALUES (?" + marks + ", ?)";
        if (sqlite3_prepare_v2(db_, sql.c_str(), -1, &st, nullptr) != SQLITE_OK) {
            err = sqlite3_errmsg(db_);
            ok = false;
            break;
        }
        sqlite3_int64 id = 1;
        {
            sqlite3_stmt* s2 = nullptr;
            std::string next = "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = '" + log.table + "'), 0) + 1";
            sqlite3_prepare_v2(db_, next.c_str(), -1, &s2, nullptr);
            if (sqlite3_step(s2) == SQLITE_ROW) id = sqlite3_column_int64(s2, 0);
            sqlite3_finalize(s2);
        }
        std::string c = chain(chains[r.log], canonical(id, r.ns, values));
        int i = 1;
        sqlite3_bind_int64(st, i++, r.ns);
        for (const Value& v : values) {
            switch (v.kind) {
                case Value::BOOL:
                case Value::INT: sqlite3_bind_int64(st, i++, v.i); break;
                case Value::REAL: sqlite3_bind_double(st, i++, v.d); break;
                case Value::TEXT: sqlite3_bind_text(st, i++, v.s.data(), int(v.s.size()), SQLITE_TRANSIENT); break;
                default: sqlite3_bind_null(st, i++);
            }
        }
        sqlite3_bind_text(st, i++, c.c_str(), -1, SQLITE_TRANSIENT);
        int rc = sqlite3_step(st);
        sqlite3_int64 got = sqlite3_last_insert_rowid(db_);
        sqlite3_finalize(st);
        if (rc != SQLITE_DONE || got != id) {
            err = rc != SQLITE_DONE ? sqlite3_errmsg(db_) : "unexpected record id";
            ok = false;
            break;
        }
        chains[r.log] = c;
    }
    if (ok) {
        for (size_t k = 0; k < logs_.size() && ok; k++) {
            if (chains[k] == logs_[k]->lastChain) continue;
            sqlite3_stmt* st = nullptr;
            sqlite3_prepare_v2(db_, "UPDATE vplc_logs SET last_chain = ? WHERE name = ?", -1, &st, nullptr);
            sqlite3_bind_text(st, 1, chains[k].c_str(), -1, SQLITE_TRANSIENT);
            sqlite3_bind_text(st, 2, logs_[k]->name.c_str(), -1, SQLITE_TRANSIENT);
            ok = sqlite3_step(st) == SQLITE_DONE;
            sqlite3_finalize(st);
        }
    }
    if (ok && run(db_, "COMMIT", err)) {
        for (size_t k = 0; k < logs_.size(); k++) logs_[k]->lastChain = chains[k];
        forwardCv_.notify_all();
    } else {
        std::string e2;
        run(db_, "ROLLBACK", e2);
        note_("Traceability: records not written: " + err);
    }
}

// Records older than the retention time (once forwarded when the log has a database)
void DataLogger::retention() {
    for (auto& l : logs_) {
        if (!l->retentionDays) continue;
        int64_t cutoff = nowNs() - int64_t(l->retentionDays) * 86400LL * 1000000000LL;
        std::string err;
        std::string sql = "DELETE FROM " + q(l->table) + " WHERE ts_ns < " + std::to_string(cutoff) + (l->dbKind ? " AND synced = 1" : "");
        if (!run(db_, sql, err)) note_("Traceability: retention: " + err);
    }
}

// ---------------------------------------------------------------------------
// Forwarding to the database of the log
// ---------------------------------------------------------------------------

void DataLogger::forward(Log* log) {
    sqlite3* local = nullptr;
    sqlite3_open_v2((dir_ + "/traceability.db").c_str(), &local, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nullptr);
    sqlite3_busy_timeout(local, 5000);
    std::unique_ptr<db::Client> client = log->dbKind == DataLogInfo::POSTGRESQL ? db::makePostgres() : db::makeMysql();
    int backoff = 1;
    while (running_) {
        std::string err;
        bool more = false;
        if (!client->connected()) {
            std::string pw = password(log->secretKey);
            bool ok = client->connect(log->db, pw, err);
            if (ok) {
                // Remote table: one row per record, (plc, log, epoch, record_id) unique -> exactly once
                std::string cols;
                for (const Column& c : log->columns) cols += ", " + client->ident(c.name) + " " + client->sqlType(c.kind);
                ok = client->exec("CREATE TABLE IF NOT EXISTS " + client->ident(log->remoteTable) + " (" + client->ident("plc") +
                                      " VARCHAR(64) NOT NULL, " + client->ident("log") + " VARCHAR(64) NOT NULL, " + client->ident("epoch") +
                                      " BIGINT NOT NULL, " + client->ident("record_id") + " BIGINT NOT NULL, " + client->ident("ts") + " " +
                                      client->timestampType() + " NOT NULL, " + client->ident("ts_ns") + " BIGINT NOT NULL" + cols + ", " +
                                      client->ident("chain") + " CHAR(64) NOT NULL, PRIMARY KEY (" + client->ident("plc") + ", " +
                                      client->ident("log") + ", " + client->ident("epoch") + ", " + client->ident("record_id") + "))",
                                  err);
                std::vector<std::string> names = {"plc", "log", "epoch", "record_id", "ts", "ts_ns"};
                for (const Column& c : log->columns) names.push_back(c.name);
                names.push_back("chain");
                if (ok) ok = client->prepare(client->insertIgnore(log->remoteTable, names), names.size(), err);
                if (!ok) client->close();
            }
            if (!ok && pw.empty() && err.find("password") != std::string::npos) err += " — set the password of " + log->secretKey + " in the Studio";
            std::lock_guard<std::mutex> lock(stateMutex_);
            log->connected = ok;
            log->error = ok ? std::string() : err;
        }
        if (client->connected()) {
            size_t sent = 0;
            if (forwardOnce(*log, *client, local, err)) {
                backoff = 1;
                more = err == "more";
                std::lock_guard<std::mutex> lock(stateMutex_);
                log->error.clear();
                (void)sent;
            } else {
                client->close();
                std::lock_guard<std::mutex> lock(stateMutex_);
                log->connected = false;
                log->error = err;
            }
        }
        bool failed;
        {
            std::lock_guard<std::mutex> lock(stateMutex_);
            failed = !log->error.empty();
        }
        if (more) continue;
        std::unique_lock<std::mutex> lock(queueMutex_);
        int waitS = failed ? backoff : 1;
        if (failed) backoff = backoff < 60 ? backoff * 2 : 60;
        forwardCv_.wait_for(lock, std::chrono::seconds(waitS), [&] { return !running_ || log->testRequested.load(); });
        log->testRequested = false;
    }
    client->close();
    sqlite3_close(local);
}

// Sends up to 500 pending records in one transaction; err = "more" when others are pending
bool DataLogger::forwardOnce(Log& log, db::Client& client, sqlite3* local, std::string& err) {
    const int LIMIT = 500;
    std::string cols;
    for (const Column& c : log.columns) cols += ", " + q(c.name);
    std::string sql = "SELECT id, ts_ns" + cols + ", chain FROM " + q(log.table) + " WHERE synced = 0 ORDER BY id LIMIT " + std::to_string(LIMIT);
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(local, sql.c_str(), -1, &st, nullptr) != SQLITE_OK) {
        err = std::string("SQLite: ") + sqlite3_errmsg(local);
        return false;
    }
    std::vector<std::vector<Value>> rows;
    std::vector<int64_t> ids;
    while (sqlite3_step(st) == SQLITE_ROW) {
        std::vector<Value> row;
        int64_t id = sqlite3_column_int64(st, 0);
        int64_t ns = sqlite3_column_int64(st, 1);
        Value v;
        v.kind = Value::TEXT; v.s = plc_; row.push_back(v);
        v.s = log.name; row.push_back(v);
        v = Value(); v.kind = Value::INT; v.i = log.epoch; row.push_back(v);
        v.i = id; row.push_back(v);
        v = Value(); v.kind = Value::TEXT; v.s = client.timestampText(ns); row.push_back(v);
        v = Value(); v.kind = Value::INT; v.i = ns; row.push_back(v);
        for (size_t k = 0; k < log.columns.size(); k++) row.push_back(columnValue(st, int(k + 2), log.columns[k].kind));
        row.push_back(columnValue(st, int(log.columns.size() + 2), Value::TEXT));
        rows.push_back(std::move(row));
        ids.push_back(id);
    }
    sqlite3_finalize(st);
    err.clear();
    if (rows.empty()) return true;
    if (!client.exec("BEGIN", err)) return false;
    for (const auto& row : rows) {
        if (!client.execute(row, err)) {
            std::string e2;
            client.exec("ROLLBACK", e2);
            return false;
        }
    }
    if (!client.exec("COMMIT", err)) return false;
    std::string mark = "UPDATE " + q(log.table) + " SET synced = 1 WHERE id >= " + std::to_string(ids.front()) + " AND id <= " +
                       std::to_string(ids.back()) + " AND synced = 0";
    if (!run(local, mark, err)) return false;
    {
        std::lock_guard<std::mutex> lock(stateMutex_);
        log.lastSyncNs = nowNs();
        log.forwarded += rows.size();
    }
    if (rows.size() == size_t(LIMIT)) err = "more";
    return true;
}

// ---------------------------------------------------------------------------
// Protocol: latest records and state
// ---------------------------------------------------------------------------

size_t DataLogger::read(uint16_t index, uint16_t count, uint64_t before, char* out, size_t cap) {
    std::string j;
    if (index >= logs_.size()) {
        j = "{\"error\":\"unknown data log\"}";
    } else {
        Log& log = *logs_[index];
        std::lock_guard<std::mutex> rl(readerMutex_);
        auto scalar = [&](const std::string& sql) -> int64_t {
            sqlite3_stmt* st = nullptr;
            int64_t v = 0;
            if (sqlite3_prepare_v2(reader_, sql.c_str(), -1, &st, nullptr) == SQLITE_OK && sqlite3_step(st) == SQLITE_ROW) v = sqlite3_column_int64(st, 0);
            sqlite3_finalize(st);
            return v;
        };
        int64_t records = scalar("SELECT COUNT(*) FROM " + q(log.table));
        int64_t pending = log.dbKind ? scalar("SELECT COUNT(*) FROM " + q(log.table) + " WHERE synced = 0") : 0;
        j = "{\"name\":" + jsonString(log.name) + ",\"plc\":" + jsonString(plc_) + ",\"epoch\":" + std::to_string(log.epoch) +
            ",\"records\":" + std::to_string(records) + ",\"pending\":" + std::to_string(pending);
        {
            std::lock_guard<std::mutex> lock(stateMutex_);
            if (log.dbKind) {
                j += ",\"destination\":" + jsonString(log.secretKey + " (" + log.remoteTable + ", TLS " +
                                                      (log.db.tls == db::Tls::VERIFY ? "verify" : log.db.tls == db::Tls::REQUIRE ? "require" : "disable") + ")");
                j += ",\"connected\":" + std::string(log.connected ? "true" : "false");
                j += ",\"forwarded\":" + std::to_string(log.forwarded);
                if (log.lastSyncNs) j += ",\"lastSync\":" + jsonString(db::utcText(log.lastSyncNs) + "Z");
                if (!log.error.empty()) j += ",\"error\":" + jsonString(log.error);
                bool hasPw;
                {
                    std::lock_guard<std::mutex> sl(secretsMutex_);
                    hasPw = false;
                    for (auto& s : secrets_) hasPw = hasPw || s.first == log.secretKey;
                }
                j += ",\"password\":" + std::string(hasPw ? "true" : "false");
            }
        }
        j += ",\"columns\":[";
        for (size_t k = 0; k < log.columns.size(); k++) j += (k ? "," : "") + jsonString(log.columns[k].name);
        j += "],\"rows\":[";
        std::string cols;
        for (const Column& c : log.columns) cols += ", " + q(c.name);
        std::string sql = "SELECT id, ts_ns" + cols + ", chain, synced FROM " + q(log.table) +
                          (before ? " WHERE id < " + std::to_string(before) : std::string()) + " ORDER BY id DESC LIMIT " + std::to_string(count);
        sqlite3_stmt* st = nullptr;
        bool first = true;
        if (count && sqlite3_prepare_v2(reader_, sql.c_str(), -1, &st, nullptr) == SQLITE_OK) {
            while (sqlite3_step(st) == SQLITE_ROW) {
                std::string row = "[" + std::to_string(sqlite3_column_int64(st, 0)) + "," + jsonString(db::utcText(sqlite3_column_int64(st, 1)) + "Z");
                for (size_t k = 0; k < log.columns.size(); k++) row += "," + jsonValue(columnValue(st, int(k + 2), log.columns[k].kind));
                const unsigned char* ch = sqlite3_column_text(st, int(log.columns.size() + 2));
                row += "," + jsonString(ch ? std::string(reinterpret_cast<const char*>(ch)).substr(0, 16) : "");
                row += std::string(",") + (sqlite3_column_int(st, int(log.columns.size() + 3)) ? "true" : "false") + "]";
                if (j.size() + row.size() + 8 > cap) break;
                j += (first ? "" : ",") + row;
                first = false;
            }
        }
        sqlite3_finalize(st);
        j += "]}";
    }
    if (j.size() >= cap) j = "{\"error\":\"response too large\"}";
    memcpy(out, j.data(), j.size());
    return j.size();
}

size_t DataLogger::test(uint16_t index, char* out, size_t cap) {
    if (index < logs_.size()) {
        logs_[index]->testRequested = true;
        forwardCv_.notify_all();
    }
    return read(index, 0, 0, out, cap);
}

// ---------------------------------------------------------------------------
// Credentials of the databases: <data dir>/secrets, readable by the CPU service only
// ---------------------------------------------------------------------------

void DataLogger::loadSecrets() {
    std::ifstream f(dir_ + "/secrets");
    std::string line;
    std::lock_guard<std::mutex> lock(secretsMutex_);
    secrets_.clear();
    while (std::getline(f, line)) {
        size_t tab = line.find('\t');
        if (tab != std::string::npos) secrets_.emplace_back(line.substr(0, tab), db::unbase64(line.substr(tab + 1)));
    }
}

std::string DataLogger::password(const std::string& key) {
    std::lock_guard<std::mutex> lock(secretsMutex_);
    for (auto& s : secrets_)
        if (s.first == key) return s.second;
    return std::string();
}

const char* DataLogger::setSecret(const char* key, const char* value) {
    std::string k = key;
    if (k.empty() || k.find('\t') != std::string::npos || k.find('\n') != std::string::npos) return "invalid key";
    {
        std::lock_guard<std::mutex> lock(secretsMutex_);
        bool found = false;
        for (auto& s : secrets_) {
            if (s.first == k) {
                s.second = value;
                found = true;
            }
        }
        if (!found) secrets_.emplace_back(k, value);
        mkdir(dir_.c_str(), 0750);
        std::string tmp = dir_ + "/secrets.tmp";
        int fd = open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
        if (fd < 0) return "cannot write the credentials file";
        std::string data;
        for (auto& s : secrets_)
            if (!s.second.empty()) data += s.first + "\t" + db::base64(s.second) + "\n";
        bool ok = ::write(fd, data.data(), data.size()) == ssize_t(data.size()) && fsync(fd) == 0;
        close(fd);
        if (!ok || rename(tmp.c_str(), (dir_ + "/secrets").c_str()) != 0) return "cannot write the credentials file";
    }
    // reconnect with the new password
    for (auto& l : logs_) {
        if (l->secretKey == k) {
            l->testRequested = true;
        }
    }
    forwardCv_.notify_all();
    return nullptr;
}

}  // namespace vplc
