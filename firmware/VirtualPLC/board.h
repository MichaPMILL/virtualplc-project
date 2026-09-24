// Capabilities of the supported boards (selected by the Arduino core macros).
#pragma once

#if defined(ARDUINO_ARCH_AVR)
#error "Arduino AVR boards (Uno, Mega, Nano) do not have enough RAM for VirtualPLC: use an ESP32, a Raspberry Pi Pico (W), an Arduino Uno R4, Nano 33 IoT, Due or Portenta"
#endif

#if defined(ESP32)
#define VPLC_BOARD "esp32"
#define VPLC_HAS_WIFI 1
#define VPLC_HAS_FS 1
#define VPLC_PROGRAM_SIZE (64u * 1024u)
#define VPLC_DATA_SIZE (64u * 1024u)
#define VPLC_ADC_BITS 12
#elif defined(ARDUINO_ARCH_RP2040)
#define VPLC_BOARD "rp2040"
#if defined(ARDUINO_RASPBERRY_PI_PICO_W) || defined(ARDUINO_RASPBERRY_PI_PICO_2W)
#define VPLC_HAS_WIFI 1
#endif
#define VPLC_HAS_FS 1
#define VPLC_PROGRAM_SIZE (64u * 1024u)
#define VPLC_DATA_SIZE (64u * 1024u)
#define VPLC_ADC_BITS 12
#elif defined(ARDUINO_UNOR4_WIFI) || defined(ARDUINO_UNOR4_MINIMA)
#define VPLC_BOARD "arduino-uno-r4"
#if defined(ARDUINO_UNOR4_WIFI)
#define VPLC_HAS_WIFI 1
#define VPLC_WIFI_S3 1
#endif
#define VPLC_HAS_EEPROM 1
#define VPLC_PROGRAM_SIZE (7u * 1024u)
#define VPLC_DATA_SIZE (8u * 1024u)
#define VPLC_ADC_BITS 14
#elif defined(ARDUINO_ARCH_SAM)
#define VPLC_BOARD "arduino-due"
#define VPLC_PROGRAM_SIZE (32u * 1024u)
#define VPLC_DATA_SIZE (32u * 1024u)
#define VPLC_ADC_BITS 12
#elif defined(ARDUINO_ARCH_MBED)
#define VPLC_BOARD "arduino-mbed"
#define VPLC_PROGRAM_SIZE (48u * 1024u)
#define VPLC_DATA_SIZE (48u * 1024u)
#define VPLC_ADC_BITS 12
#else
#define VPLC_BOARD "arduino"
#define VPLC_PROGRAM_SIZE (6u * 1024u)
#define VPLC_DATA_SIZE (6u * 1024u)
#define VPLC_ADC_BITS 10
#endif

#ifndef VPLC_HAS_WIFI
#define VPLC_HAS_WIFI 0
#endif
#ifndef VPLC_HAS_FS
#define VPLC_HAS_FS 0
#endif
#ifndef VPLC_HAS_EEPROM
#define VPLC_HAS_EEPROM 0
#endif
