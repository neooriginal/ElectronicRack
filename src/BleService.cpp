#include "BleService.h"

#include <ArduinoJson.h>
#include <NimBLEDevice.h>

#include "App.h"
#include "Config.h"

namespace {

constexpr char kServiceUuid[] = "6e5f0001-b5a3-f393-e0a9-e50e24dcca9e";
constexpr char kIdentityUuid[] = "6e5f0002-b5a3-f393-e0a9-e50e24dcca9e";
constexpr char kSecretUuid[] = "6e5f0003-b5a3-f393-e0a9-e50e24dcca9e";
constexpr char kCommandUuid[] = "6e5f0004-b5a3-f393-e0a9-e50e24dcca9e";
constexpr char kEventUuid[] = "6e5f0005-b5a3-f393-e0a9-e50e24dcca9e";

BleService* self = nullptr;

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, ble_gap_conn_desc* desc) override {
    (void)s;
    (void)desc;
    // The preferred MTU is set once in begin(), before advertising starts;
    // the exchange itself is negotiated by the central right after connect.
    // Calling setMTU() here again was a no-op on an already-open connection.
    if (self) self->setConnected(true);
  }
  void onDisconnect(NimBLEServer* s) override {
    if (self) self->setConnected(false);
    // Without this the rack is invisible after the browser closes the tab.
    NimBLEDevice::startAdvertising();
  }
};

class CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c) override {
    if (!self) return;
    const std::string v = c->getValue();
    if (v.empty()) return;
    self->onCommand(String(v.c_str()));
  }
};

// NimBLECharacteristic::setValue(const char*) resolves to a template that
// memcpys the raw pointer, not the string — see the long comment where this
// is first hit in BleOta.cpp. Route every text write through here instead.
void setText(NimBLECharacteristic* c, const String& s) {
  c->setValue(reinterpret_cast<const uint8_t*>(s.c_str()), s.length());
}

}  // namespace

void BleService::begin(App* app) {
  app_ = app;
  self = this;

  NimBLEDevice::init(("Rack-" + app_->identity.rackId().substring(6)).c_str());
  NimBLEDevice::setMTU(BLE_MTU);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);

  server_ = NimBLEDevice::createServer();
  server_->setCallbacks(new ServerCallbacks());

  NimBLEService* svc = server_->createService(kServiceUuid);

  JsonDocument idDoc;
  idDoc["rackId"] = app_->identity.rackId();
  idDoc["fw"] = FW_VERSION;
  idDoc["git"] = FW_GIT;
  idDoc["leds"] = app_->config.ledCount;
  idDoc["rows"] = app_->config.rows;
  idDoc["cols"] = app_->config.cols;
  String idJson;
  serializeJson(idDoc, idJson);

  NimBLECharacteristic* ident =
      svc->createCharacteristic(kIdentityUuid, NIMBLE_PROPERTY::READ);
  setText(ident, idJson);

  NimBLECharacteristic* secret =
      svc->createCharacteristic(kSecretUuid, NIMBLE_PROPERTY::READ);
  setText(secret, app_->identity.secret());

  NimBLECharacteristic* cmd = svc->createCharacteristic(
      kCommandUuid, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  cmd->setCallbacks(new CommandCallbacks());

  event_ = svc->createCharacteristic(kEventUuid, NIMBLE_PROPERTY::NOTIFY);

  ota_.begin(svc);

  svc->start();

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(kServiceUuid);
  adv->setScanResponse(true);
  NimBLEDevice::startAdvertising();

  Serial.printf("[ble] advertising as Rack-%s\n",
                app_->identity.rackId().substring(6).c_str());
}

void BleService::setConnected(bool up) {
  connected_ = up;
  if (up) {
    sendReady_ = true;
    Serial.println("[ble] browser connected");
  } else {
    expectSeq_ = 0;
    stockBuf_.clear();
    Serial.println("[ble] browser disconnected");
  }
}

void BleService::emit(const String& json) {
  if (!event_ || !connected_) return;
  setText(event_, json);
  event_->notify();
}

void BleService::onCommand(const String& json) {
  JsonDocument doc;
  if (deserializeJson(doc, json)) {
    emit("{\"t\":\"err\",\"why\":\"json\"}");
    return;
  }
  applyCommand(doc);
}

void BleService::applyStockChunk(const JsonDocument& doc) {
  const int seq = doc["seq"] | 0;
  if (seq != expectSeq_) {
    // Out of order: the browser must start the snapshot again rather than us
    // lighting a half-applied rack.
    expectSeq_ = 0;
    stockBuf_.clear();
    emit("{\"t\":\"err\",\"of\":\"stock\",\"why\":\"seq\"}");
    return;
  }

  for (JsonVariantConst v : doc["cells"].as<JsonArrayConst>()) {
    CellLight cl;
    cl.row = v["row"] | 0;
    cl.col = v["col"] | 0;
    cl.qty = v["qty"] | 0;
    cl.color = parseHexColor(v["color"] | "#8a8a8a", 0x8A8A8A);
    cl.occupied = cl.qty > 0;
    stockBuf_.push_back(cl);
  }

  if (doc["more"] | false) {
    expectSeq_ = seq + 1;
    return;
  }
  app_->leds.setStock(stockBuf_);
  stockBuf_.clear();
  expectSeq_ = 0;
  emit("{\"t\":\"ack\",\"of\":\"stock\"}");
}

void BleService::applyCommand(const JsonDocument& doc) {
  const char* t = doc["t"] | "";

  if (strcmp(t, "stock") == 0) {
    applyStockChunk(doc);
    return;
  }

  if (strcmp(t, "locate") == 0) {
    app_->leds.locate(doc["row"] | 0, doc["col"] | 0);
    return;
  }

  if (strcmp(t, "flash") == 0) {
    app_->leds.flash(doc["row"] | 0, doc["col"] | 0,
                     parseHexColor(doc["color"] | "#3DDC84", 0x3DDC84),
                     doc["ms"] | 420);
    return;
  }

  if (strcmp(t, "identify") == 0) {
    app_->leds.identifyLed(doc["index"] | 0);
    return;
  }

  if (strcmp(t, "mode") == 0) {
    const char* m = doc["mode"] | "idle";
    if (strcmp(m, "idle") == 0) app_->leds.setIdle();
    else if (strcmp(m, "off") == 0) app_->leds.off();
    else if (strcmp(m, "startup") == 0) app_->leds.playStartup();
    else if (strcmp(m, "corners") == 0) app_->leds.showCorners();
    else if (strcmp(m, "walk") == 0) app_->leds.startWalk(doc["dwell"] | 280);
    else if (strcmp(m, "stop") == 0) app_->leds.stopWalk();
    return;
  }

  if (strcmp(t, "grid") == 0) {
    app_->config.rows = doc["rows"] | app_->config.rows;
    app_->config.cols = doc["cols"] | app_->config.cols;
    app_->applyConfig(false);
    return;
  }

  if (strcmp(t, "wiring") == 0) {
    app_->applyWiring(doc.as<JsonVariantConst>());
    return;
  }

  if (strcmp(t, "leds") == 0) {
    app_->applyLedConfig(doc.as<JsonVariantConst>());
    return;
  }

  emit("{\"t\":\"err\",\"why\":\"unknown\"}");
}

void BleService::notifyWalk(uint8_t row, uint8_t col, int led) {
  JsonDocument doc;
  doc["t"] = "walk";
  doc["row"] = row;
  doc["col"] = col;
  doc["led"] = led;
  String out;
  serializeJson(doc, out);
  emit(out);
}

void BleService::loop() {
  if (sendReady_ && connected_) {
    sendReady_ = false;
    emit("{\"t\":\"ready\"}");
  }

  // Mirror the calibration walk so the browser can highlight the live cell.
  if (app_ && app_->leds.walking() && connected_) {
    uint8_t r = 0, c = 0;
    int led = -1;
    if (app_->leds.walkStep(r, c, led) && led != lastWalkLed_) {
      lastWalkLed_ = led;
      notifyWalk(r, c, led);
    }
  } else {
    lastWalkLed_ = -2;
  }
}
