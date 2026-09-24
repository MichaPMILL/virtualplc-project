// Compile-time limits of the VirtualPLC core. Platforms may override them
// with -D flags (small microcontrollers use smaller values).
#pragma once

// Microcontrollers (Arduino framework): no PROFINET tables; boards with about 32 KB of RAM
// (Arduino Uno R4, Nano 33 IoT...) get smaller buffers. -D flags still take precedence.
#if defined(ARDUINO)
#ifndef VPLC_PN_MAX_SUBMODULES
#define VPLC_PN_MAX_SUBMODULES 0
#endif
#ifndef VPLC_PN_RECORD_POOL
#define VPLC_PN_RECORD_POOL 0
#endif
#if !defined(ESP32) && !defined(ARDUINO_ARCH_RP2040) && !defined(ARDUINO_ARCH_MBED) && !defined(ARDUINO_ARCH_SAM)
#define VPLC_SMALL_MCU 1
#ifndef VPLC_MAX_PAYLOAD
#define VPLC_MAX_PAYLOAD 1024
#endif
#ifndef VPLC_MAX_STACK
#define VPLC_MAX_STACK 128
#endif
#ifndef VPLC_MAX_CALL_DEPTH
#define VPLC_MAX_CALL_DEPTH 16
#endif
#ifndef VPLC_LOG_ENTRIES
#define VPLC_LOG_ENTRIES 12
#endif
#ifndef VPLC_LOG_LENGTH
#define VPLC_LOG_LENGTH 72
#endif
#ifndef VPLC_MAX_FORCES
#define VPLC_MAX_FORCES 16
#endif
#endif
#endif

#ifndef VPLC_MAX_CALL_DEPTH
#define VPLC_MAX_CALL_DEPTH 32
#endif

#ifndef VPLC_MAX_STACK
#define VPLC_MAX_STACK 256
#endif

#ifndef VPLC_MAX_PAYLOAD
#define VPLC_MAX_PAYLOAD 4096
#endif

#ifndef VPLC_LOG_ENTRIES
#define VPLC_LOG_ENTRIES 32
#endif

#ifndef VPLC_LOG_LENGTH
#define VPLC_LOG_LENGTH 120
#endif

#ifndef VPLC_MAX_FORCES
#define VPLC_MAX_FORCES 32
#endif

// PROFINET configuration kept per I/O module (remote IO-Devices: submodules and default
// parameter records). Microcontrollers without PROFINET use 0 / 0.
#ifndef VPLC_PN_MAX_SUBMODULES
#define VPLC_PN_MAX_SUBMODULES 64
#endif

#ifndef VPLC_PN_RECORD_POOL
#define VPLC_PN_RECORD_POOL 4096
#endif

#ifndef VPLC_FIRMWARE_VERSION
#define VPLC_FIRMWARE_VERSION "0.1.0"
#endif

// Backward jumps between two watchdog checks (reading the clock is not free on MCUs).
#ifndef VPLC_WATCHDOG_STRIDE
#define VPLC_WATCHDOG_STRIDE 256
#endif
