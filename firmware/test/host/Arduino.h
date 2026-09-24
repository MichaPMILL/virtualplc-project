// Minimal Arduino API on Linux to run the firmware sketch in tests (not a full emulation):
// Serial = a serial device or pseudo-terminal (VPLC_SIM_SERIAL), pins = files in
// VPLC_SIM_PINS (inputs read from "in-<pin>", outputs written to "out-<pin>").
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
#define LOW 0
#define HIGH 1

uint32_t millis();
uint32_t micros();
void delay(uint32_t ms);
void yield();
void pinMode(uint8_t pin, uint8_t mode);
int digitalRead(uint8_t pin);
void digitalWrite(uint8_t pin, uint8_t value);
int analogRead(uint8_t pin);
void analogWrite(uint8_t pin, int value);

class HostSerial {
public:
    void begin(unsigned long baud);
    void setTimeout(unsigned long) {}
    int available();
    size_t readBytes(char* buf, size_t n);
    size_t write(const uint8_t* p, size_t n);

private:
    int fd_ = -1;
};
extern HostSerial Serial;
