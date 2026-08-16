#pragma once

#include <Arduino.h>

class NimBLEService;
class NimBLECharacteristic;
class BleService;

// Firmware updates over the same BLE link as everything else. The browser
// fetches the image (it has internet access; the rack does not) and streams it
// here in chunks. A failed or aborted update leaves the currently running
// image untouched — Update.h only swaps the boot partition on a verified end().
class BleOta {
public:
  void begin(NimBLEService* svc);

  // Called from the characteristic callbacks.
  void onControl(const String& json);
  void onData(const uint8_t* data, size_t len);

private:
  void start(size_t size, uint32_t expectedCrc);
  void finish();
  void abort(const char* why);
  void notify(const String& json);

  NimBLECharacteristic* control_ = nullptr;
  NimBLECharacteristic* data_ = nullptr;

  bool active_ = false;
  size_t expectedSize_ = 0;
  size_t written_ = 0;
  uint32_t expectedCrc_ = 0;
  uint32_t runningCrc_ = 0;
};
