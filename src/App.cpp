#include "App.h"

#include <ArduinoJson.h>

namespace {

void configToJson(const AppConfig& c, JsonDocument& doc) {
  doc.clear();
  doc["version"] = 1;
  doc["rackName"] = c.rackName;
  doc["rows"] = c.rows;
  doc["cols"] = c.cols;

  JsonObject leds = doc["leds"].to<JsonObject>();
  leds["pin"] = c.ledPin;
  leds["count"] = c.ledCount;
  leds["order"] = colorOrderName(c.order);
  leds["brightness"] = c.brightness;
  leds["idleBrightness"] = c.idleBrightness;
  leds["locateColor"] = hexColor(c.locateColor);
  leds["idleAnim"] = idleAnimName(c.idleAnim);
  leds["startupAnim"] = startupAnimName(c.startupAnim);

  JsonObject wiring = doc["wiring"].to<JsonObject>();
  wiring["origin"] = originName(c.origin);
  wiring["rowFirst"] = c.rowFirst;
  wiring["serpentine"] = c.serpentine;
  wiring["offset"] = c.ledOffset;

  JsonObject ov = doc["overrides"].to<JsonObject>();
  for (const auto& kv : c.overrides) {
    ov[String(kv.first)] = kv.second;
  }

  JsonObject ui = doc["ui"].to<JsonObject>();
  ui["locateOnSelect"] = c.locateOnSelect;
  ui["locateHoldMs"] = c.locateHoldMs;
  ui["lowStockQty"] = c.lowStockQty;
  ui["remoteSearch"] = c.remoteSearch;
}

}  // namespace

App app;

void App::begin() {
  mux_ = xSemaphoreCreateMutex();
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n" FW_NAME " " FW_VERSION " (%s)\n", FW_GIT);

  if (!store.begin()) {
    Serial.println("[app] filesystem unavailable — running with defaults");
  }

  JsonDocument cfgDoc;
  if (store.readJson("/config.json", cfgDoc)) {
    bool rebuild = false;
    mergeConfig(cfgDoc, rebuild);
  }
  config.clamp();
  rack.bind(&config);

  inventory.load(store);
  leds.begin(config, &rack);
  refreshStockLights();

  wifi.begin([this]() { leds.loop(); });
  http.begin(this);
  ota.begin([this](const char* json) { http.broadcast(json); });
}

void App::loop() {
  wifi.loop();
  leds.loop();
  http.loop();
  ota.loop();
  if (inventoryDirty_ && millis() - inventoryDirtyAt_ >= 450) flushInventory();
}

void App::lock() {
  if (mux_) xSemaphoreTake(mux_, portMAX_DELAY);
}

void App::unlock() {
  if (mux_) xSemaphoreGive(mux_);
}

bool App::saveConfig() {
  JsonDocument doc;
  configToJson(config, doc);
  return store.writeJson("/config.json", doc);
}

bool App::saveInventory() {
  inventoryDirty_ = false;
  return inventory.save(store);
}

void App::markInventoryDirty() {
  inventoryDirty_ = true;
  inventoryDirtyAt_ = millis();
}

void App::flushInventory() {
  if (!inventoryDirty_) return;
  saveInventory();
}

void App::applyConfig(bool rebuildLeds) {
  config.clamp();
  rack.bind(&config);
  if (rebuildLeds) leds.applyHardware(config);
  else leds.setConfig(config);
  refreshStockLights();
}

void App::refreshStockLights() {
  std::vector<CellLight> snap;
  inventory.snapshot(snap);
  leds.setStock(snap);
}

bool App::mergeConfig(JsonVariantConst src, bool& rebuildLeds) {
  rebuildLeds = false;
  if (src["rackName"].is<const char*>()) config.rackName = src["rackName"].as<const char*>();
  if (src["rows"].is<int>()) config.rows = static_cast<uint8_t>(src["rows"].as<int>());
  if (src["cols"].is<int>()) config.cols = static_cast<uint8_t>(src["cols"].as<int>());

  JsonVariantConst leds = src["leds"];
  if (!leds.isNull()) {
    if (leds["pin"].is<int>()) {
      config.ledPin = static_cast<uint8_t>(leds["pin"].as<int>());
      rebuildLeds = true;
    }
    if (leds["count"].is<int>()) {
      config.ledCount = static_cast<uint16_t>(leds["count"].as<int>());
      rebuildLeds = true;
    }
    if (leds["order"].is<const char*>()) {
      ColorOrder o;
      if (colorOrderFromName(leds["order"].as<const char*>(), o)) {
        config.order = o;
        rebuildLeds = true;
      }
    }
    if (leds["brightness"].is<int>()) config.brightness = static_cast<uint8_t>(leds["brightness"].as<int>());
    if (leds["idleBrightness"].is<int>())
      config.idleBrightness = static_cast<uint8_t>(leds["idleBrightness"].as<int>());
    if (leds["locateColor"].is<const char*>())
      config.locateColor = parseHexColor(leds["locateColor"].as<const char*>(), config.locateColor);
    if (leds["idleAnim"].is<const char*>()) {
      IdleAnim a;
      if (idleAnimFromName(leds["idleAnim"].as<const char*>(), a)) config.idleAnim = a;
    }
    if (leds["startupAnim"].is<const char*>()) {
      StartupAnim a;
      if (startupAnimFromName(leds["startupAnim"].as<const char*>(), a)) config.startupAnim = a;
    }
  }

  JsonVariantConst wiring = src["wiring"];
  if (!wiring.isNull()) {
    if (wiring["origin"].is<const char*>()) {
      WiringOrigin o;
      if (originFromName(wiring["origin"].as<const char*>(), o)) config.origin = o;
    }
    if (wiring["rowFirst"].is<bool>()) config.rowFirst = wiring["rowFirst"].as<bool>();
    if (wiring["serpentine"].is<bool>()) config.serpentine = wiring["serpentine"].as<bool>();
    if (wiring["offset"].is<int>()) config.ledOffset = static_cast<int16_t>(wiring["offset"].as<int>());
  }

  JsonVariantConst ov = src["overrides"];
  if (ov.is<JsonObjectConst>()) {
    config.overrides.clear();
    JsonObjectConst obj = ov.as<JsonObjectConst>();
    for (JsonPairConst kv : obj) {
      config.overrides[atoi(kv.key().c_str())] = kv.value().as<int>();
    }
  }

  JsonVariantConst ui = src["ui"];
  if (!ui.isNull()) {
    if (ui["locateOnSelect"].is<bool>()) config.locateOnSelect = ui["locateOnSelect"].as<bool>();
    if (ui["locateHoldMs"].is<int>()) config.locateHoldMs = static_cast<uint16_t>(ui["locateHoldMs"].as<int>());
    if (ui["lowStockQty"].is<int>()) config.lowStockQty = ui["lowStockQty"].as<int>();
    if (ui["remoteSearch"].is<bool>()) config.remoteSearch = ui["remoteSearch"].as<bool>();
  }

  // Flat keys from partial UI patches
  if (src["pin"].is<int>()) {
    config.ledPin = static_cast<uint8_t>(src["pin"].as<int>());
    rebuildLeds = true;
  }
  config.clamp();
  return true;
}
