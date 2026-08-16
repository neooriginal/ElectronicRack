#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

#include <vector>

#include "BleOta.h"
#include "Types.h"

class App;
class NimBLEServer;
class NimBLECharacteristic;

// The rack's only interface to the outside world. Replaces the Wi-Fi station and
// the HTTP server: the browser connects over BLE, reads identity, pushes config
// and stock, and drives the LEDs.
class BleService {
public:
  void begin(App* app);
  void loop();

  bool connected() const { return connected_; }
  void notifyWalk(uint8_t row, uint8_t col, int led);

  // Internal, called from NimBLE callbacks.
  void onCommand(const String& json);
  void setConnected(bool up);

private:
  void emit(const String& json);
  void applyCommand(const JsonDocument& doc);
  void applyStockChunk(const JsonDocument& doc);

  App* app_ = nullptr;
  NimBLEServer* server_ = nullptr;
  NimBLECharacteristic* event_ = nullptr;
  BleOta ota_;
  bool connected_ = false;
  bool sendReady_ = false;

  // Reassembly for stock snapshots too large for one write.
  int expectSeq_ = 0;
  std::vector<CellLight> stockBuf_;

  int lastWalkLed_ = -2;
};
