#pragma once

// Compile-time limits and factory defaults.
// The rack keeps no runtime data: the grid, wiring map and stock all arrive over
// BLE from the browser on each connect. Only the identity and the LED hardware
// descriptor persist, both in NVS.

#define FW_VERSION        "2.0.0"
#ifndef FW_GIT
#define FW_GIT            "dev"
#endif
#define FW_NAME           "ElectronicRack"

// A larger MTU means fewer chunks per stock snapshot. 517 is the BLE 4.2 maximum
// and what Chrome negotiates; NimBLE falls back automatically for lesser peers.
#define BLE_MTU           517

#define MAX_ROWS          16
#define MAX_COLS          16
#define MAX_CELLS         (MAX_ROWS * MAX_COLS)
#define MAX_LEDS          300

#define DEFAULT_ROWS      6
#define DEFAULT_COLS      6
#define DEFAULT_LED_PIN   13
#define DEFAULT_LED_COUNT 36
#define DEFAULT_BRIGHTNESS      72
#define DEFAULT_IDLE_BRIGHTNESS 18

#define LED_FRAME_MS      20
