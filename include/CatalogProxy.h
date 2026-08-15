#pragma once

#include <ArduinoJson.h>
#include <Arduino.h>

class CatalogProxy {
public:
  // Blocking HTTPS lookup. Call from a worker task, not the LED loop.
  bool search(const String& query, JsonDocument& out, String& err);
};
