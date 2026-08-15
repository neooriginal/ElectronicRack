#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

class Store {
public:
  bool begin();
  bool exists(const char* path) const;
  bool readJson(const char* path, JsonDocument& doc);
  bool writeJson(const char* path, const JsonDocument& doc);
  bool writeRaw(const char* path, const char* data, size_t len);
  bool remove(const char* path);
};
