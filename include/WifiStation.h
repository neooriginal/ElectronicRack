#pragma once

#include <Arduino.h>
#include <functional>

class WifiStation {
public:
  void begin(const std::function<void()>& pump = {});
  void loop();

  bool connected() const;
  bool apMode() const { return apMode_; }
  String ip() const;
  String ssid() const;
  int rssi() const;
  String mac() const;

private:
  void startAp();
  bool apMode_ = false;
  uint32_t lastAttempt_ = 0;
};
