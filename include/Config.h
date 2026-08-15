#pragma once

// Compile-time limits and factory defaults.
// Runtime settings (grid, wiring, LEDs, animations) live in LittleFS /config.json.

#define FW_VERSION        "1.0.0"
#ifndef FW_GIT
#define FW_GIT            "dev"
#endif
#define FW_NAME           "ElectronicRack"
#define MDNS_HOSTNAME     "rack"
#define HTTP_PORT         80

// Rolling GitHub Release used by OTA. Assets: firmware.bin, littlefs.bin, version.json
#define GITHUB_REPO       "neooriginal/ElectronicRack"
#define OTA_VERSION_URL   "https://github.com/" GITHUB_REPO "/releases/latest/download/version.json"
#define OTA_FIRMWARE_URL  "https://github.com/" GITHUB_REPO "/releases/latest/download/firmware.bin"
#define OTA_FS_URL        "https://github.com/" GITHUB_REPO "/releases/latest/download/littlefs.bin"

#define MAX_ROWS          16
#define MAX_COLS          16
#define MAX_CELLS         (MAX_ROWS * MAX_COLS)
#define MAX_LEDS          300
#define MAX_ITEMS         256
#define MAX_LOCS_PER_ITEM 8

#define DEFAULT_ROWS      6
#define DEFAULT_COLS      6
#define DEFAULT_LED_PIN   13
#define DEFAULT_LED_COUNT 36
#define DEFAULT_BRIGHTNESS      72
#define DEFAULT_IDLE_BRIGHTNESS 18

#define WIFI_CONNECT_TIMEOUT_MS 18000
#define HTTP_BODY_MAX           (96 * 1024)
#define REMOTE_SEARCH_TIMEOUT_MS 8000
#define REMOTE_SEARCH_LIMIT     12

#define STATUS_BROADCAST_MS     3000
#define LED_FRAME_MS            20
