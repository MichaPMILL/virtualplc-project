// Compile-time limits of the VirtualPLC core. Platforms may override them
// with -D flags (small microcontrollers use smaller values).
#pragma once

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

#ifndef VPLC_FIRMWARE_VERSION
#define VPLC_FIRMWARE_VERSION "0.1.0"
#endif

// Backward jumps between two watchdog checks (reading the clock is not free on MCUs).
#ifndef VPLC_WATCHDOG_STRIDE
#define VPLC_WATCHDOG_STRIDE 256
#endif
