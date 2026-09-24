// VirtualPLC CPU firmware for microcontrollers (ESP32, Raspberry Pi Pico W, Arduino Uno R4,
// Due, Portenta...). The Studio connects through the USB serial link, or through Wi-Fi
// (TCP port 20105) on boards that have it. Settings: settings.h.
//
// Build: arduino-cli compile --fqbn esp32:esp32:esp32 --library ../../runtime/core
//        (or PlatformIO: see ../platformio.ini)
#include <Arduino.h>

#include "board.h"
#include "cpu.h"
#include "mcu_platform.h"
#include "protocol.h"
#include "settings.h"

#if VPLC_HAS_WIFI
#if defined(VPLC_WIFI_S3)
#include <WiFiS3.h>
#else
#include <WiFi.h>
#endif
#endif

using namespace vplc;

namespace {

McuPlatform platform;
uint8_t* programBuffer = nullptr;
uint8_t* arena = nullptr;
size_t programCapacity = 0, arenaCapacity = 0;
Cpu* cpu = nullptr;

// One protocol endpoint (serial link or TCP client)
struct Link {
    FrameParser parser;
    Session session;
};
Link serialLink;
uint8_t response[VPLC_MAX_PAYLOAD + 16];

/** Allocates the program and data memory (heap: sized for the board, smaller if needed) */
uint8_t* allocate(size_t wanted, size_t& got) {
    for (size_t n = wanted; n >= 2048; n /= 2) {
        uint8_t* p = static_cast<uint8_t*>(malloc(n));
        if (p) {
            memset(p, 0, n);
            got = n;
            return p;
        }
    }
    got = 0;
    return nullptr;
}

/** Feeds received bytes to a link and sends the responses */
template <typename Out>
void serve(Link& link, const uint8_t* data, size_t n, Out send) {
    for (size_t i = 0; i < n; i++) {
        FrameParser::Result r = link.parser.feed(data[i]);
        if (r == FrameParser::ERROR) {
            link.parser.reset();  // noise on the line: wait for the next frame
            continue;
        }
        if (r == FrameParser::FRAME) {
            size_t len = cpu->handle(link.session, link.parser.command(), link.parser.sequence(), link.parser.payload(), link.parser.length(), response);
            send(response, len);
        }
    }
}

#if VPLC_HAS_WIFI
WiFiServer server(VPLC_PORT);
WiFiClient client;
Link tcpLink;
bool wifiStarted = false, serverStarted = false, timeStarted = false;
uint32_t wifiRetryAt = 0;

void startWifi() {
    if (strlen(VPLC_WIFI_SSID) == 0) return;
#if !defined(VPLC_WIFI_S3)
    IPAddress ip, mask, gw;
    if (strlen(VPLC_WIFI_IP) && ip.fromString(VPLC_WIFI_IP) && mask.fromString(VPLC_WIFI_MASK)) {
        if (!gw.fromString(VPLC_WIFI_GATEWAY)) gw = ip;
#if defined(ESP32)
        WiFi.config(ip, gw, mask, gw);
#else
        WiFi.config(ip, gw, mask);
#endif
    }
#endif
#if defined(ESP32) || defined(ARDUINO_ARCH_RP2040)
    WiFi.mode(WIFI_STA);
#endif
    WiFi.begin(VPLC_WIFI_SSID, VPLC_WIFI_PASSWORD);
    wifiStarted = true;
}

void serviceWifi() {
    if (!wifiStarted) return;
    if (WiFi.status() != WL_CONNECTED) {
        if (serverStarted && millis() > wifiRetryAt) {  // lost: reconnect from time to time
            wifiRetryAt = millis() + 10000;
            WiFi.disconnect();
            WiFi.begin(VPLC_WIFI_SSID, VPLC_WIFI_PASSWORD);
        }
        return;
    }
    if (!serverStarted) {
        server.begin();
        serverStarted = true;
        char msg[72];
        IPAddress ip = WiFi.localIP();
        snprintf(msg, sizeof msg, "Wi-Fi connected: %u.%u.%u.%u port %u", ip[0], ip[1], ip[2], ip[3], unsigned(VPLC_PORT));
        cpu->log(msg);
    }
#if defined(ESP32) || defined(ARDUINO_ARCH_RP2040)
    if (!timeStarted) {
#if defined(ESP32)
        configTzTime(VPLC_TIME_ZONE, VPLC_NTP_SERVER);
#else
        NTP.begin(VPLC_NTP_SERVER);
        setenv("TZ", VPLC_TIME_ZONE, 1);
        tzset();
#endif
        timeStarted = true;
    }
#endif
    // one client at a time: a new connection replaces the previous one
#if defined(ESP32)
    WiFiClient incoming = server.accept();
#else
    WiFiClient incoming = server.available();
#endif
    if (incoming && (!client || !client.connected() || incoming.remoteIP() != client.remoteIP() || incoming.remotePort() != client.remotePort())) {
        if (client) client.stop();
        client = incoming;
        client.setNoDelay(true);
        tcpLink.parser.reset();
        tcpLink.session = Session();
    }
    if (!client || !client.connected()) return;
    uint8_t buf[256];
    int avail;
    while ((avail = client.available()) > 0) {
        int n = client.read(buf, avail < int(sizeof buf) ? avail : int(sizeof buf));
        if (n <= 0) break;
        serve(tcpLink, buf, size_t(n), [](const uint8_t* p, size_t len) { client.write(p, len); });
    }
}
#endif

void serviceSerial() {
    uint8_t buf[128];
    int avail;
    while ((avail = Serial.available()) > 0) {
        size_t n = Serial.readBytes(reinterpret_cast<char*>(buf), avail < int(sizeof buf) ? size_t(avail) : sizeof buf);
        if (!n) break;
        serve(serialLink, buf, n, [](const uint8_t* p, size_t len) { Serial.write(p, len); });
    }
}

}  // namespace

void setup() {
    Serial.begin(VPLC_SERIAL_BAUD);
    Serial.setTimeout(5);
    platform.begin();
    programBuffer = allocate(VPLC_PROGRAM_SIZE, programCapacity);
    arena = allocate(VPLC_DATA_SIZE, arenaCapacity);
    static Cpu instance(platform, programBuffer, programCapacity, arena, arenaCapacity);
    cpu = &instance;
    cpu->setName(VPLC_CPU_NAME);
    cpu->setPassword(VPLC_CPU_PASSWORD);
    cpu->setWatchdog(VPLC_WATCHDOG_MS);
    char msg[72];
    snprintf(msg, sizeof msg, "VirtualPLC %s on %s: program %u KB, data %u KB", VPLC_FIRMWARE_VERSION, VPLC_BOARD, unsigned(programCapacity / 1024),
             unsigned(arenaCapacity / 1024));
    cpu->log(msg);
#if VPLC_HAS_WIFI
    startWifi();
#endif
    cpu->begin(true);
}

void loop() {
    serviceSerial();
#if VPLC_HAS_WIFI
    serviceWifi();
#endif
    cpu->loop();
    yield();
}
