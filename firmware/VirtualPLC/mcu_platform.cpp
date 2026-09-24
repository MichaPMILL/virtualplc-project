// VirtualPLC platform for microcontrollers (see mcu_platform.h).
#include "mcu_platform.h"

#include <string.h>
#include <time.h>

#include "isa.h"
#include "settings.h"

#if VPLC_HAS_FS
#include <LittleFS.h>
#endif
#if VPLC_HAS_EEPROM
#include <EEPROM.h>
#endif

namespace vplc {

namespace {
const char* PROGRAM_FILE = "/program.vplc";
const char* PROGRAM_TMP = "/program.tmp";
// Analog values use the nominal range of the usual PLC analog modules
constexpr uint32_t ANALOG_FULL_SCALE = 27648;
}  // namespace

void McuPlatform::begin() {
#if VPLC_HAS_FS
#if defined(ESP32)
    storageOk_ = LittleFS.begin(true);  // formats the partition the first time
#else
    storageOk_ = LittleFS.begin();
    if (!storageOk_) {
        LittleFS.format();
        storageOk_ = LittleFS.begin();
    }
#endif
    if (!storageOk_) note("Program storage (LittleFS) unavailable: the program is lost at power off");
#elif VPLC_HAS_EEPROM
    storageOk_ = true;
#else
    note("No program storage on this board: the program is lost at power off");
#endif
#if defined(ESP32) || defined(ARDUINO_ARCH_RP2040)
    analogReadResolution(VPLC_ADC_BITS);
#endif
}

void McuPlatform::log(const char* message) {
    // The serial port carries the device protocol: messages only go to the
    // diagnostic buffer of the CPU (read by the Studio).
    (void)message;
}

void McuPlatform::note(const char* message) {
    if (noteCount_ >= 4) return;
    size_t n = strnlen(message, sizeof notes_[0] - 1);
    memcpy(notes_[noteCount_], message, n);
    notes_[noteCount_][n] = 0;
    noteCount_++;
}

void McuPlatform::drainMessages(void (*record)(void* ctx, const char* message), void* ctx) {
    for (uint8_t i = 0; i < noteCount_; i++) record(ctx, notes_[i]);
    noteCount_ = 0;
}

bool McuPlatform::clock(bool local, int64_t& ns) {
#if VPLC_HAS_WIFI && (defined(ESP32) || defined(ARDUINO_ARCH_RP2040))
    time_t now = time(nullptr);
    if (now < 1600000000) return false;  // not synchronised yet
    int64_t t = int64_t(now);
    if (local) {
        struct tm l, g;
        localtime_r(&now, &l);
        gmtime_r(&now, &g);
        l.tm_isdst = 0;  // the difference of both broken-down times is the offset
        g.tm_isdst = 0;
        t += int64_t(mktime(&l) - mktime(&g));
    }
    ns = t * 1000000000LL + int64_t(::micros() % 1000000u) * 1000LL;
    return true;
#else
    (void)local;
    ns = 0;
    return false;
#endif
}

// ---------------------------------------------------------------------------
// Program storage
// ---------------------------------------------------------------------------

bool McuPlatform::storeProgram(const uint8_t* image, size_t length) {
#if VPLC_HAS_FS
    if (!storageOk_) return true;  // kept in RAM only
    File f = LittleFS.open(PROGRAM_TMP, "w");
    if (!f) return false;
    bool ok = f.write(image, length) == length;
    f.close();
    if (!ok) return false;
    LittleFS.remove(PROGRAM_FILE);
    return LittleFS.rename(PROGRAM_TMP, PROGRAM_FILE);
#elif VPLC_HAS_EEPROM
    if (length + 4 > size_t(EEPROM.length())) {
        note("Program larger than the EEPROM: not kept at power off");
        return true;
    }
    for (int i = 0; i < 4; i++) EEPROM.update(i, uint8_t(length >> (8 * i)));
    for (size_t i = 0; i < length; i++) EEPROM.update(int(4 + i), image[i]);
    return true;
#else
    (void)image;
    (void)length;
    return true;
#endif
}

size_t McuPlatform::loadProgram(uint8_t* buf, size_t capacity) {
#if VPLC_HAS_FS
    if (!storageOk_ || !LittleFS.exists(PROGRAM_FILE)) return 0;
    File f = LittleFS.open(PROGRAM_FILE, "r");
    if (!f) return 0;
    size_t n = f.size();
    if (n > capacity) {
        f.close();
        return 0;
    }
    n = f.read(buf, n);
    f.close();
    return n;
#elif VPLC_HAS_EEPROM
    uint32_t n = 0;
    for (int i = 0; i < 4; i++) n |= uint32_t(EEPROM.read(i)) << (8 * i);
    if (n == 0 || n == 0xFFFFFFFFu || n > capacity || n + 4 > uint32_t(EEPROM.length())) return 0;
    for (uint32_t i = 0; i < n; i++) buf[i] = EEPROM.read(int(4 + i));
    return n;
#else
    (void)buf;
    (void)capacity;
    return 0;
#endif
}

// ---------------------------------------------------------------------------
// I/O modules
// ---------------------------------------------------------------------------

uint16_t McuPlatform::configureIo(const Program& program) {
    count_ = 0;
    IoModuleReader reader(program.ioconf);
    static IoModuleInfo info;  // large structure: not on the stack
    while (reader.next(info)) {
        Module& m = modules_[count_ < MAX_MODULES ? count_ : MAX_MODULES - 1];
        m = Module();
        m.kind = info.kind;
        m.pin = info.pin;
        m.bit = info.bit;
        m.flags = info.flags;
        m.byte = info.byte;
        char msg[72];
        switch (IoModule(info.kind)) {
            case IoModule::IO_GPIO_DI:
                pinMode(m.pin, (m.flags & 2) ? INPUT_PULLUP : INPUT);
                m.ok = true;
                break;
            case IoModule::IO_GPIO_DO:
                pinMode(m.pin, OUTPUT);
                digitalWrite(m.pin, (m.flags & 1) ? HIGH : LOW);  // off
                m.ok = true;
                break;
            case IoModule::IO_GPIO_AI:
                pinMode(m.pin, INPUT);
                m.ok = true;
                break;
            case IoModule::IO_GPIO_AO:
#if VPLC_HAS_ANALOG_OUT
                pinMode(m.pin, OUTPUT);
                m.ok = true;
#else
                note("Analog outputs are not supported on this board");
#endif
                break;
            default:
                snprintf(msg, sizeof msg, "I/O module %u: not supported on this board", unsigned(count_));
                note(msg);
                break;
        }
        if (count_ < MAX_MODULES) count_++;
    }
    return count_;
}

void McuPlatform::readInputs(uint8_t* image, uint32_t size) {
    for (uint16_t k = 0; k < count_; k++) {
        const Module& m = modules_[k];
        if (!m.ok) continue;
        if (m.kind == uint8_t(IoModule::IO_GPIO_DI)) {
            if (m.byte >= size) continue;
            bool v = digitalRead(m.pin) == HIGH;
            if (m.flags & 1) v = !v;
            if (v) image[m.byte] |= uint8_t(1u << m.bit);
            else image[m.byte] &= uint8_t(~(1u << m.bit));
        } else if (m.kind == uint8_t(IoModule::IO_GPIO_AI)) {
            if (m.byte + 1u >= size) continue;
            uint32_t raw = uint32_t(analogRead(m.pin));
            uint32_t v = raw * ANALOG_FULL_SCALE / ((1u << VPLC_ADC_BITS) - 1u);
            image[m.byte] = uint8_t(v >> 8);  // big endian, as %IW
            image[m.byte + 1] = uint8_t(v);
        }
    }
}

void McuPlatform::writeOutputs(const uint8_t* image, uint32_t size) {
    for (uint16_t k = 0; k < count_; k++) {
        const Module& m = modules_[k];
        if (!m.ok) continue;
        if (m.kind == uint8_t(IoModule::IO_GPIO_DO)) {
            if (m.byte >= size) continue;
            bool v = (image[m.byte] >> m.bit) & 1;
            if (m.flags & 1) v = !v;
            digitalWrite(m.pin, v ? HIGH : LOW);
        } else if (m.kind == uint8_t(IoModule::IO_GPIO_AO)) {
            if (m.byte + 1u >= size) continue;
            int32_t v = int16_t((image[m.byte] << 8) | image[m.byte + 1]);
            if (v < 0) v = 0;
            if (v > int32_t(ANALOG_FULL_SCALE)) v = ANALOG_FULL_SCALE;
#if defined(ESP32) && defined(SOC_DAC_SUPPORTED) && SOC_DAC_SUPPORTED
            if (m.pin == 25 || m.pin == 26) {  // true analog output (DAC)
                dacWrite(m.pin, uint8_t(uint32_t(v) * 255u / ANALOG_FULL_SCALE));
                continue;
            }
#endif
#if VPLC_HAS_ANALOG_OUT
            analogWrite(m.pin, int(uint32_t(v) * 255u / ANALOG_FULL_SCALE));  // PWM
#endif
        }
    }
}

}  // namespace vplc
