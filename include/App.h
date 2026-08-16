#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

#include "BleService.h"
#include "Config.h"
#include "Identity.h"
#include "LedEngine.h"
#include "Rack.h"
#include "Types.h"

// The rack is now a BLE peripheral that lights bins. It holds no inventory: the
// browser owns that, backed by the server's database, and pushes a stock
// snapshot on every connect. The only thing persisted here is the identity and
// the LED hardware descriptor, because without pin/count/order nothing lights.
class App {
public:
  Identity identity;
  RackModel rack;
  LedEngine leds;
  BleService ble;
  AppConfig config;

  void begin();
  void loop();

  void applyConfig(bool rebuildLeds);
  void applyWiring(JsonVariantConst src);
  void applyLedConfig(JsonVariantConst src);

private:
  void loadLedConfig();
  void saveLedConfig();
};

extern App app;
