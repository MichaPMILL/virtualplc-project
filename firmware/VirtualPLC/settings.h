// Settings of the VirtualPLC firmware: edit before flashing (or pass -D flags).
#pragma once

// Name of the CPU shown in the Studio
#ifndef VPLC_CPU_NAME
#define VPLC_CPU_NAME "PLC_1"
#endif

// Access password of the CPU ("" = none)
#ifndef VPLC_CPU_PASSWORD
#define VPLC_CPU_PASSWORD ""
#endif

// USB / serial link with the Studio (the Studio uses the same speed)
#ifndef VPLC_SERIAL_BAUD
#define VPLC_SERIAL_BAUD 115200
#endif

// Wi-Fi (boards with Wi-Fi): leave the SSID empty to use the USB link only
#ifndef VPLC_WIFI_SSID
#define VPLC_WIFI_SSID ""
#endif
#ifndef VPLC_WIFI_PASSWORD
#define VPLC_WIFI_PASSWORD ""
#endif
// Fixed address, e.g. "192.168.0.50" (empty: DHCP), with mask and gateway
#ifndef VPLC_WIFI_IP
#define VPLC_WIFI_IP ""
#endif
#ifndef VPLC_WIFI_MASK
#define VPLC_WIFI_MASK "255.255.255.0"
#endif
#ifndef VPLC_WIFI_GATEWAY
#define VPLC_WIFI_GATEWAY ""
#endif

// Device protocol port (as vplc-cpu)
#ifndef VPLC_PORT
#define VPLC_PORT 20105
#endif

// Time (RD_SYS_T / RD_LOC_T) from NTP when connected: server and POSIX time zone
#ifndef VPLC_NTP_SERVER
#define VPLC_NTP_SERVER "pool.ntp.org"
#endif
#ifndef VPLC_TIME_ZONE
#define VPLC_TIME_ZONE "CET-1CEST,M3.5.0,M10.5.0/3"
#endif

// Maximum scan time before the CPU goes to FAULT
#ifndef VPLC_WATCHDOG_MS
#define VPLC_WATCHDOG_MS 500
#endif
