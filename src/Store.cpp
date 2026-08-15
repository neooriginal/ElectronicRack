#include "Store.h"

#include <LittleFS.h>

bool Store::begin() {
  if (!LittleFS.begin(true)) {
    Serial.println("[store] LittleFS mount failed");
    return false;
  }
  return true;
}

bool Store::exists(const char* path) const {
  return LittleFS.exists(path);
}

bool Store::readJson(const char* path, JsonDocument& doc) {
  File f = LittleFS.open(path, "r");
  if (!f) return false;
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err) {
    Serial.printf("[store] parse %s: %s\n", path, err.c_str());
    return false;
  }
  return true;
}

bool Store::writeJson(const char* path, const JsonDocument& doc) {
  String tmp = String(path) + ".tmp";
  File f = LittleFS.open(tmp.c_str(), "w");
  if (!f) {
    Serial.printf("[store] open %s failed\n", tmp.c_str());
    return false;
  }
  size_t n = serializeJson(doc, f);
  f.close();
  if (n == 0) {
    LittleFS.remove(tmp.c_str());
    return false;
  }
  String bak = String(path) + ".bak";
  if (LittleFS.exists(path)) {
    LittleFS.remove(bak.c_str());
    LittleFS.rename(path, bak.c_str());
  }
  if (!LittleFS.rename(tmp.c_str(), path)) {
    Serial.printf("[store] rename %s failed\n", path);
    return false;
  }
  return true;
}

bool Store::writeRaw(const char* path, const char* data, size_t len) {
  String tmp = String(path) + ".tmp";
  File f = LittleFS.open(tmp.c_str(), "w");
  if (!f) return false;
  size_t n = f.write(reinterpret_cast<const uint8_t*>(data), len);
  f.close();
  if (n != len) {
    LittleFS.remove(tmp.c_str());
    return false;
  }
  LittleFS.remove(path);
  return LittleFS.rename(tmp.c_str(), path);
}

bool Store::remove(const char* path) {
  if (!LittleFS.exists(path)) return true;
  return LittleFS.remove(path);
}
