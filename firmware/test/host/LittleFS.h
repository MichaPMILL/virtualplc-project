// LittleFS on a folder (VPLC_SIM_FS) for the host simulation of the firmware.
#pragma once
#include <stdio.h>

#include <string>

class File {
public:
    File() = default;
    explicit File(FILE* f) : f_(f) {}
    explicit operator bool() const { return f_ != nullptr; }
    size_t write(const uint8_t* p, size_t n) { return fwrite(p, 1, n, f_); }
    size_t read(uint8_t* p, size_t n) { return fread(p, 1, n, f_); }
    size_t size();
    void close() {
        if (f_) fclose(f_);
        f_ = nullptr;
    }

private:
    FILE* f_ = nullptr;
};

class HostFs {
public:
    bool begin();
    bool format();
    bool exists(const char* path);
    File open(const char* path, const char* mode);
    bool remove(const char* path);
    bool rename(const char* from, const char* to);

private:
    std::string path(const char* p) const;
    std::string root_;
};
extern HostFs LittleFS;
