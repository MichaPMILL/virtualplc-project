// Host implementation of the Arduino shim, and main() running setup() / loop().
#include <fcntl.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#include <chrono>
#include <string>
#include <thread>

#include "Arduino.h"
#include "LittleFS.h"

HostSerial Serial;
HostFs LittleFS;

namespace {
const auto start = std::chrono::steady_clock::now();
std::string pinsDir() {
    const char* d = getenv("VPLC_SIM_PINS");
    return d ? d : ".";
}
}  // namespace

uint32_t millis() {
    return uint32_t(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count());
}
uint32_t micros() {
    return uint32_t(std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - start).count());
}
void delay(uint32_t ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }
void yield() { std::this_thread::sleep_for(std::chrono::microseconds(200)); }

void pinMode(uint8_t, uint8_t) {}

int digitalRead(uint8_t pin) {
    FILE* f = fopen((pinsDir() + "/in-" + std::to_string(pin)).c_str(), "r");
    if (!f) return LOW;
    int v = fgetc(f) == '1' ? HIGH : LOW;
    fclose(f);
    return v;
}

int analogRead(uint8_t pin) {
    FILE* f = fopen((pinsDir() + "/in-" + std::to_string(pin)).c_str(), "r");
    if (!f) return 0;
    int v = 0;
    if (fscanf(f, "%d", &v) != 1) v = 0;
    fclose(f);
    return v;
}

static void writePin(uint8_t pin, int value) {
    std::string path = pinsDir() + "/out-" + std::to_string(pin);
    FILE* f = fopen((path + ".tmp").c_str(), "w");
    if (!f) return;
    fprintf(f, "%d\n", value);
    fclose(f);
    rename((path + ".tmp").c_str(), path.c_str());
}
void digitalWrite(uint8_t pin, uint8_t value) { writePin(pin, value); }
void analogWrite(uint8_t pin, int value) { writePin(pin, value); }

void HostSerial::begin(unsigned long) {
    const char* dev = getenv("VPLC_SIM_SERIAL");
    fd_ = dev ? open(dev, O_RDWR | O_NOCTTY | O_NONBLOCK) : -1;
    if (fd_ >= 0) {
        termios t{};
        if (tcgetattr(fd_, &t) == 0) {
            cfmakeraw(&t);
            tcsetattr(fd_, TCSANOW, &t);
        }
    }
}

int HostSerial::available() {
    int n = 0;
    return fd_ >= 0 && ioctl(fd_, FIONREAD, &n) == 0 ? n : 0;
}

size_t HostSerial::readBytes(char* buf, size_t n) {
    ssize_t r = fd_ >= 0 ? read(fd_, buf, n) : -1;
    return r > 0 ? size_t(r) : 0;
}

size_t HostSerial::write(const uint8_t* p, size_t n) {
    size_t off = 0;
    while (fd_ >= 0 && off < n) {
        ssize_t w = ::write(fd_, p + off, n - off);
        if (w > 0) off += size_t(w);
        else std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return off;
}

size_t File::size() {
    long pos = ftell(f_);
    fseek(f_, 0, SEEK_END);
    long n = ftell(f_);
    fseek(f_, pos, SEEK_SET);
    return n > 0 ? size_t(n) : 0;
}

std::string HostFs::path(const char* p) const { return root_ + p; }
bool HostFs::begin() {
    const char* d = getenv("VPLC_SIM_FS");
    root_ = d ? d : ".";
    mkdir(root_.c_str(), 0755);
    return true;
}
bool HostFs::format() { return true; }
bool HostFs::exists(const char* p) { return access(path(p).c_str(), F_OK) == 0; }
File HostFs::open(const char* p, const char* mode) { return File(fopen(path(p).c_str(), mode[0] == 'w' ? "wb" : "rb")); }
bool HostFs::remove(const char* p) { return ::remove(path(p).c_str()) == 0; }
bool HostFs::rename(const char* a, const char* b) { return ::rename(path(a).c_str(), path(b).c_str()) == 0; }

void setup();
void loop();

int main() {
    setup();
    for (;;) loop();
}
