#include "App.h"

#include <ArduinoJson.h>
#include <Preferences.h>

App app;

void App::begin() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n" FW_NAME " " FW_VERSION " (%s)\n", FW_GIT);

  identity.begin();
  loadLedConfig();
  config.clamp();
  rack.bind(&config);

  leds.begin(config, &rack);
  ble.begin(this);
}

void App::loop() {
  leds.loop();
  ble.loop();
  // Yield a tick so the idle task can run and the BLE host keeps its timing.
  delay(1);
}

void App::applyConfig(bool rebuildLeds) {
  config.clamp();
  rack.bind(&config);
  if (rebuildLeds) leds.applyHardware(config);
  else leds.setConfig(config);
}

void App::applyWiring(JsonVariantConst src) {
  if (src["origin"].is<const char*>()) {
    WiringOrigin o;
    if (originFromName(src["origin"].as<const char*>(), o)) config.origin = o;
  }
  if (src["rowFirst"].is<bool>()) config.rowFirst = src["rowFirst"].as<bool>();
  if (src["serpentine"].is<bool>()) config.serpentine = src["serpentine"].as<bool>();
  if (src["offset"].is<int>()) config.ledOffset = static_cast<int16_t>(src["offset"].as<int>());

  JsonVariantConst ov = src["overrides"];
  if (ov.is<JsonObjectConst>()) {
    config.overrides.clear();
    for (JsonPairConst kv : ov.as<JsonObjectConst>()) {
      config.overrides[atoi(kv.key().c_str())] = kv.value().as<int>();
    }
  }
  applyConfig(false);
}

void App::applyLedConfig(JsonVariantConst src) {
  bool rebuild = false;
  if (src["pin"].is<int>()) {
    config.ledPin = static_cast<uint8_t>(src["pin"].as<int>());
    rebuild = true;
  }
  if (src["count"].is<int>()) {
    config.ledCount = static_cast<uint16_t>(src["count"].as<int>());
    rebuild = true;
  }
  if (src["order"].is<const char*>()) {
    ColorOrder o;
    if (colorOrderFromName(src["order"].as<const char*>(), o)) {
      config.order = o;
      rebuild = true;
    }
  }
  if (src["brightness"].is<int>())
    config.brightness = static_cast<uint8_t>(src["brightness"].as<int>());
  if (src["idleBrightness"].is<int>())
    config.idleBrightness = static_cast<uint8_t>(src["idleBrightness"].as<int>());
  if (src["locateColor"].is<const char*>())
    config.locateColor = parseHexColor(src["locateColor"].as<const char*>(), config.locateColor);
  if (src["locateHoldMs"].is<int>())
    config.locateHoldMs = static_cast<uint16_t>(src["locateHoldMs"].as<int>());
  if (src["idleAnim"].is<const char*>()) {
    IdleAnim a;
    if (idleAnimFromName(src["idleAnim"].as<const char*>(), a)) config.idleAnim = a;
  }
  if (src["startupAnim"].is<const char*>()) {
    StartupAnim a;
    if (startupAnimFromName(src["startupAnim"].as<const char*>(), a)) config.startupAnim = a;
  }

  applyConfig(rebuild);
  saveLedConfig();
}

void App::loadLedConfig() {
  Preferences prefs;
  prefs.begin("rackled", true);
  config.ledPin = prefs.getUChar("pin", config.ledPin);
  config.ledCount = prefs.getUShort("count", config.ledCount);
  config.order = static_cast<ColorOrder>(prefs.getUChar("order", static_cast<uint8_t>(config.order)));
  config.brightness = prefs.getUChar("bri", config.brightness);
  config.idleBrightness = prefs.getUChar("idlebri", config.idleBrightness);
  config.rows = prefs.getUChar("rows", config.rows);
  config.cols = prefs.getUChar("cols", config.cols);
  prefs.end();
}

void App::saveLedConfig() {
  Preferences prefs;
  prefs.begin("rackled", false);
  prefs.putUChar("pin", config.ledPin);
  prefs.putUShort("count", config.ledCount);
  prefs.putUChar("order", static_cast<uint8_t>(config.order));
  prefs.putUChar("bri", config.brightness);
  prefs.putUChar("idlebri", config.idleBrightness);
  prefs.putUChar("rows", config.rows);
  prefs.putUChar("cols", config.cols);
  prefs.end();
}
