#pragma once

#include <Arduino.h>

class App;

class HttpApp {
public:
  void begin(App* app);
  void loop();

  void broadcast(const char* json);
  void notifyDirty(const char* what);
  void notifyWalk(uint8_t row, uint8_t col, int led);

private:
  void registerRoutes();
  App* app_ = nullptr;
  uint32_t lastStatus_ = 0;
  int lastWalkLed_ = -2;
};
