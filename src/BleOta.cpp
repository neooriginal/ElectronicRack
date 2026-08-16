#include "BleOta.h"

#include <ArduinoJson.h>
#include <NimBLEDevice.h>
#include <Update.h>
#include <esp32/rom/crc.h>

namespace {
constexpr char kControlUuid[] = "6e5f0006-b5a3-f393-e0a9-e50e24dcca9e";
constexpr char kDataUuid[] = "6e5f0007-b5a3-f393-e0a9-e50e24dcca9e";

BleOta* self = nullptr;

class ControlCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c) override {
    if (self) self->onControl(String(c->getValue().c_str()));
  }
};

class DataCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c) override {
    if (!self) return;
    const std::string v = c->getValue();
    self->onData(reinterpret_cast<const uint8_t*>(v.data()), v.size());
  }
};
}  // namespace

void BleOta::begin(NimBLEService* svc) {
  self = this;
  control_ = svc->createCharacteristic(
      kControlUuid, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
  control_->setCallbacks(new ControlCallbacks());
  data_ = svc->createCharacteristic(kDataUuid, NIMBLE_PROPERTY::WRITE_NR);
  data_->setCallbacks(new DataCallbacks());
}

void BleOta::notify(const String& json) {
  if (!control_) return;
  // Not setValue(const char*): NimBLECharacteristic's templated setValue<T>
  // shadows the library's own (correct) const-char* overload and instead
  // memcpys the raw pointer value into the attribute. The (uint8_t*, size_t)
  // overload is the only one that actually copies the string's bytes.
  control_->setValue(reinterpret_cast<const uint8_t*>(json.c_str()), json.length());
  control_->notify();
}

void BleOta::onControl(const String& json) {
  JsonDocument doc;
  if (deserializeJson(doc, json)) return;
  const char* t = doc["t"] | "";

  if (strcmp(t, "start") == 0) {
    start(doc["size"] | 0, strtoul((doc["crc32"] | "0"), nullptr, 16));
  } else if (strcmp(t, "abort") == 0) {
    abort("cancelled");
  }
}

void BleOta::start(size_t size, uint32_t expectedCrc) {
  if (active_) abort("restarted");

  if (size == 0 || size > 0x1F0000 /* one OTA slot, see partitions.csv */) {
    notify("{\"t\":\"error\",\"why\":\"too-large\"}");
    return;
  }

  if (!Update.begin(size, U_FLASH)) {
    Serial.printf("[ota] begin failed: %s\n", Update.errorString());
    notify("{\"t\":\"error\",\"why\":\"flash\"}");
    return;
  }

  active_ = true;
  expectedSize_ = size;
  expectedCrc_ = expectedCrc;
  written_ = 0;
  runningCrc_ = 0;
  Serial.printf("[ota] start, %u bytes expected\n", static_cast<unsigned>(size));
}

void BleOta::onData(const uint8_t* data, size_t len) {
  if (!active_ || !len) return;

  if (written_ + len > expectedSize_) {
    abort("overflow");
    return;
  }

  if (Update.write(const_cast<uint8_t*>(data), len) != len) {
    Serial.printf("[ota] write failed: %s\n", Update.errorString());
    abort("write");
    return;
  }

  runningCrc_ = crc32_le(runningCrc_, data, len);
  written_ += len;

  JsonDocument doc;
  doc["t"] = "progress";
  doc["written"] = written_;
  doc["size"] = expectedSize_;
  String out;
  serializeJson(doc, out);
  notify(out);

  if (written_ >= expectedSize_) finish();
}

void BleOta::finish() {
  if (expectedCrc_ && runningCrc_ != expectedCrc_) {
    Serial.printf("[ota] crc mismatch: got %08x want %08x\n", runningCrc_, expectedCrc_);
    Update.abort();
    active_ = false;
    notify("{\"t\":\"error\",\"why\":\"crc\"}");
    return;
  }

  if (!Update.end(true)) {
    Serial.printf("[ota] end failed: %s\n", Update.errorString());
    active_ = false;
    notify("{\"t\":\"error\",\"why\":\"flash\"}");
    return;
  }

  active_ = false;
  Serial.println("[ota] complete — rebooting");
  notify("{\"t\":\"done\"}");
  delay(300);  // let the notify actually go out before the radio drops
  ESP.restart();
}

void BleOta::abort(const char* why) {
  if (active_) Update.abort();
  active_ = false;
  written_ = 0;
  Serial.printf("[ota] aborted: %s\n", why);
  JsonDocument doc;
  doc["t"] = "error";
  doc["why"] = why;
  String out;
  serializeJson(doc, out);
  notify(out);
}
