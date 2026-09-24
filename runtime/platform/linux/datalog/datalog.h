// Traceability on the Linux CPU: the records of the data logs are written to a local SQLite
// database (store and forward: nothing is lost while the network or the server is down), each
// one chained to the previous one with SHA-256 (any change or deletion is detected), then
// copied to the PostgreSQL / MySQL / MariaDB database of the log, exactly once.
#pragma once
#include <sqlite3.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "program.h"
#include "sql.h"

namespace vplc {

class DataLogger {
public:
    DataLogger(std::string dir, std::function<void(const std::string&)> note);
    ~DataLogger();

    // Data logs of a newly loaded program; false if the local database cannot be opened
    bool configure(const Program& program, const std::string& plcName);
    // Called by the CPU thread: queues a record (false if the queue is full)
    bool push(uint16_t log, int64_t timeNs, const uint8_t* values, uint32_t length);
    size_t read(uint16_t log, uint16_t count, uint64_t before, bool full, char* out, size_t cap);
    size_t test(uint16_t log, char* out, size_t cap);
    const char* setSecret(const char* key, const char* value);

    // Canonical text of a record and hash chain (also implemented by the verifier of the SDK)
    static std::string canonical(int64_t recordId, int64_t timeNs, const std::vector<db::Value>& values);
    static std::string genesis(const std::string& plc, const std::string& log, int64_t epoch);
    static std::string chain(const std::string& previous, const std::string& canonical);

private:
    struct Column {
        std::string name;
        uint8_t type = 0, bit = 0xFF;
        uint16_t size = 0;
        db::Value::Kind kind = db::Value::INT;
    };
    struct Log {
        std::string name, table;  // table: local table log_<name>
        std::vector<Column> columns;
        uint16_t retentionDays = 0;
        int64_t epoch = 0;
        std::string lastChain;
        // remote database
        uint8_t dbKind = 0;
        db::Config db;
        std::string remoteTable, secretKey;
        // forwarding state (guarded by stateMutex_)
        std::string error;
        bool connected = false;
        int64_t lastSyncNs = 0;
        uint64_t forwarded = 0;
        std::atomic<bool> testRequested{false};
        std::thread forwarder;
    };
    struct Record {
        uint16_t log;
        int64_t ns;
        std::vector<uint8_t> values;
    };

    void stop();
    bool openLocal(std::string& err);
    bool prepareLocal(Log& log, std::string& err);
    std::vector<db::Value> decode(const Log& log, const uint8_t* values, uint32_t length) const;
    void writer();
    void writeBatch(std::deque<Record>& batch);
    void retention();
    void forward(Log* log);
    bool forwardOnce(Log& log, db::Client& client, sqlite3* local, std::string& err);
    std::string password(const std::string& key);
    db::Identity identity_;
    void loadSecrets();

    std::string dir_;
    std::function<void(const std::string&)> note_;
    std::string plc_;
    sqlite3* db_ = nullptr;          // writer connection
    sqlite3* reader_ = nullptr;      // protocol reads
    std::mutex readerMutex_;
    std::vector<std::unique_ptr<Log>> logs_;
    std::mutex queueMutex_;
    std::condition_variable queueCv_;
    std::deque<Record> queue_;
    std::atomic<bool> running_{false};
    std::thread writer_;
    std::mutex stateMutex_;
    std::condition_variable forwardCv_;
    std::mutex secretsMutex_;
    std::vector<std::pair<std::string, std::string>> secrets_;
    uint64_t dropped_ = 0;
    static constexpr size_t MAX_QUEUE = 100000;
};

}  // namespace vplc
