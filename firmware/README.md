# VirtualPLC firmware for microcontrollers

The same CPU core as `vplc-cpu` (bytecode VM, device protocol, diagnostic buffer, forcing)
running on microcontroller boards, programmed and monitored from VirtualPLC Studio through
the **USB serial link** or **Wi-Fi**.

| Board                                   | Link           | Program / data | Program kept at power off |
|-----------------------------------------|----------------|----------------|---------------------------|
| ESP32 (DevKit, ESP32-S3…)               | USB, Wi-Fi     | 64 KB / 64 KB  | yes (LittleFS)            |
| Raspberry Pi Pico W / Pico 2 W          | USB, Wi-Fi     | 64 KB / 64 KB  | yes (LittleFS)            |
| Raspberry Pi Pico / Pico 2              | USB            | 64 KB / 64 KB  | yes (LittleFS)            |
| Arduino Uno R4 WiFi / Minima            | USB (+ Wi-Fi)  | 7 KB / 8 KB    | yes (EEPROM)              |
| Arduino Due, Portenta / Nano 33 (mbed)  | USB            | 32–48 KB       | no                        |
| Arduino Uno / Mega / Nano (AVR)         | —              | not enough RAM | —                         |

I/O: the modules of the *Configuration des appareils* — digital inputs / outputs (inversion,
pull-up), analog inputs (scaled 0…27648 like PLC analog modules) and analog outputs (DAC on
ESP32 pins 25 / 26, PWM elsewhere). Time (`RD_SYS_T`, `RD_LOC_T`) comes from NTP on Wi-Fi boards.

## Settings

Edit `VirtualPLC/settings.h` before flashing (or pass them as `-D` flags): CPU name and
password, Wi-Fi SSID / password (empty: USB only), fixed IP address, serial speed (115200),
time zone.

## Build and flash

Arduino IDE: open `VirtualPLC/VirtualPLC.ino`, and add the folder `runtime/core` as a
library (*Sketch > Include library > Add .ZIP library…* on a zip of the folder, or copy it to
`~/Arduino/libraries/VirtualPLC_core`).

arduino-cli (from the repository root):

```bash
# ESP32 (core "esp32" by Espressif)
arduino-cli compile --fqbn esp32:esp32:esp32 --library runtime/core firmware/VirtualPLC
arduino-cli upload  --fqbn esp32:esp32:esp32 -p /dev/ttyUSB0 firmware/VirtualPLC
# Raspberry Pi Pico W (core "rp2040" by Earle Philhower)
arduino-cli compile --fqbn rp2040:rp2040:rpipicow --library runtime/core firmware/VirtualPLC
# Arduino Uno R4 WiFi
arduino-cli compile --fqbn arduino:renesas_uno:unor4wifi --library runtime/core firmware/VirtualPLC
```

PlatformIO: `cd firmware && pio run -e esp32dev -t upload` (see `platformio.ini`).

## In the Studio

Add a device of type *CPU VirtualPLC ESP32* or *CPU VirtualPLC Arduino*; in *Charger dans
l'appareil* / *Liaison en ligne*, choose *USB / liaison série* and the port (COM3,
/dev/ttyUSB0, /dev/cu.usbserial…, the detected ports are proposed) with the speed of
`settings.h`, or *TCP/IP* with the address shown in the diagnostic buffer when Wi-Fi is set.
Opening the serial port may restart the board: the Studio waits for it.

## Tests

- `firmware/test/host`: a small Arduino shim runs the unmodified sketch on Linux
  (`runtime/build/vplc-firmware-sim`); `sdk/test/firmware.test.ts` downloads a program
  through a pseudo-terminal, drives simulated pins and checks the restart after a power cycle.
- `.github/workflows/firmware.yml` builds the firmware for ESP32, ESP32-S3, Pico W,
  Uno R4 WiFi and Due.
