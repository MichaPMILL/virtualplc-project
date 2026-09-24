// VirtualPLC CPU firmware for microcontrollers (ESP32, Raspberry Pi Pico (W), Arduino Uno R4,
// Due, Portenta...). The Studio connects through the USB serial link, or through Wi-Fi
// (TCP port 20105) on boards that have it. Settings: settings.h.
//
// Build: arduino-cli compile --fqbn esp32:esp32:esp32 --library ../../runtime/core
//        (or PlatformIO: see ../platformio.ini)
#include "firmware.h"

void setup() { vplcSetup(); }

void loop() { vplcLoop(); }
