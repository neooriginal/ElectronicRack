#include "HttpApp.h"

#include <ArduinoJson.h>
#include <ESPAsyncWebServer.h>
#include <LittleFS.h>
#include <WiFi.h>

#include "App.h"
#include "Config.h"

namespace {

AsyncWebServer server(HTTP_PORT);
AsyncWebSocket ws("/ws");

void sendJson(AsyncWebServerRequest* req, int code, const JsonDocument& doc) {
  AsyncResponseStream* res = req->beginResponseStream("application/json");
  res->setCode(code);
  serializeJson(doc, *res);
  req->send(res);
}

void sendErr(AsyncWebServerRequest* req, int code, const char* msg) {
  JsonDocument doc;
  doc["error"] = msg;
  sendJson(req, code, doc);
}

void sendOk(AsyncWebServerRequest* req) {
  JsonDocument doc;
  doc["ok"] = true;
  sendJson(req, 200, doc);
}

bool readCell(App* app, JsonVariantConst v, uint8_t& row, uint8_t& col) {
  if (v["cell"].is<const char*>()) {
    return app->rack.parseLabel(v["cell"].as<const char*>(), row, col);
  }
  if (v["row"].is<int>() && v["col"].is<int>()) {
    row = static_cast<uint8_t>(v["row"].as<int>());
    col = static_cast<uint8_t>(v["col"].as<int>());
    return app->rack.inBounds(row, col);
  }
  return false;
}

void fillStatus(App* app, JsonDocument& doc) {
  doc["ok"] = true;
  doc["fw"] = FW_VERSION;
  doc["name"] = FW_NAME;
  doc["ip"] = app->wifi.ip();
  doc["ssid"] = app->wifi.ssid();
  doc["rssi"] = app->wifi.rssi();
  doc["mac"] = app->wifi.mac();
  doc["ap"] = app->wifi.apMode();
  doc["heap"] = ESP.getFreeHeap();
  doc["uptime"] = millis() / 1000;
  doc["ledMode"] = static_cast<int>(app->leds.mode());
  doc["cells"] = app->rack.cellCount();
  doc["items"] = app->inventory.items().size();
}

void fillConfig(App* app, JsonDocument& doc) {
  doc.clear();
  doc["version"] = 1;
  doc["rackName"] = app->config.rackName;
  doc["rows"] = app->config.rows;
  doc["cols"] = app->config.cols;
  JsonObject leds = doc["leds"].to<JsonObject>();
  leds["pin"] = app->config.ledPin;
  leds["count"] = app->config.ledCount;
  leds["order"] = colorOrderName(app->config.order);
  leds["brightness"] = app->config.brightness;
  leds["idleBrightness"] = app->config.idleBrightness;
  leds["locateColor"] = hexColor(app->config.locateColor);
  leds["idleAnim"] = idleAnimName(app->config.idleAnim);
  leds["startupAnim"] = startupAnimName(app->config.startupAnim);
  JsonObject wiring = doc["wiring"].to<JsonObject>();
  wiring["origin"] = originName(app->config.origin);
  wiring["rowFirst"] = app->config.rowFirst;
  wiring["serpentine"] = app->config.serpentine;
  wiring["offset"] = app->config.ledOffset;
  JsonObject ov = doc["overrides"].to<JsonObject>();
  for (const auto& kv : app->config.overrides) ov[String(kv.first)] = kv.second;
  JsonObject ui = doc["ui"].to<JsonObject>();
  ui["locateOnSelect"] = app->config.locateOnSelect;
  ui["locateHoldMs"] = app->config.locateHoldMs;
  ui["lowStockQty"] = app->config.lowStockQty;
  ui["remoteSearch"] = app->config.remoteSearch;

  JsonArray map = doc["map"].to<JsonArray>();
  for (uint8_t r = 0; r < app->config.rows; r++) {
    for (uint8_t c = 0; c < app->config.cols; c++) {
      JsonObject cell = map.add<JsonObject>();
      cell["row"] = r;
      cell["col"] = c;
      cell["cell"] = app->rack.label(r, c);
      cell["led"] = app->rack.ledFor(r, c);
    }
  }
}

void protoFromJson(Item& item, JsonVariantConst v) {
  item.id = v["id"] | "";
  item.name = v["name"] | "";
  item.mpn = v["mpn"] | "";
  item.sku = v["sku"] | "";
  item.category = v["category"] | "other";
  item.pkg = v["package"] | v["pkg"] | "";
  item.brand = v["brand"] | "";
  item.notes = v["notes"] | "";
  item.source = v["source"] | "";
  if (v["color"].is<const char*>()) {
    item.color = parseHexColor(v["color"].as<const char*>(), categoryColor(item.category));
  } else {
    item.color = categoryColor(item.category);
  }
}

String takeBody(AsyncWebServerRequest* req) {
  if (!req->_tempObject) return "";
  return String(static_cast<const char*>(req->_tempObject));
}

void onBody(AsyncWebServerRequest* request, uint8_t* data, size_t len, size_t index, size_t total) {
  if (total > HTTP_BODY_MAX) return;
  if (index == 0) {
    if (request->_tempObject) {
      free(request->_tempObject);
      request->_tempObject = nullptr;
    }
    void* buf = malloc(total + 1);
    if (!buf) return;
    request->_tempObject = buf;
  }
  if (!request->_tempObject) return;
  memcpy(static_cast<uint8_t*>(request->_tempObject) + index, data, len);
  if (index + len >= total) {
    static_cast<char*>(request->_tempObject)[total] = 0;
  }
}

void onWsEvent(AsyncWebSocket* server, AsyncWebSocketClient* client, AwsEventType type, void* arg,
               uint8_t* data, size_t len) {
  (void)server;
  (void)arg;
  if (type != WS_EVT_DATA) return;
  AwsFrameInfo* info = static_cast<AwsFrameInfo*>(arg);
  if (!info->final || info->index != 0 || info->opcode != WS_TEXT) return;
  JsonDocument doc;
  if (deserializeJson(doc, data, len)) return;
  const char* t = doc["t"] | "";
  if (strcmp(t, "ping") == 0) {
    client->text("{\"t\":\"pong\"}");
  }
}

}  // namespace

void HttpApp::begin(App* application) {
  app_ = application;

  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin", "*");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers", "Content-Type");

  ws.onEvent(onWsEvent);
  server.addHandler(&ws);
  registerRoutes();
  server.serveStatic("/", LittleFS, "/")
      .setDefaultFile("index.html")
      .setCacheControl("public,max-age=300");
  server.onNotFound([](AsyncWebServerRequest* req) {
    if (req->method() == HTTP_OPTIONS) {
      req->send(204);
      return;
    }
    if (LittleFS.exists("/index.html")) {
      req->send(LittleFS, "/index.html", "text/html");
      return;
    }
    req->send(404, "text/plain", "Not found. Upload the filesystem image (pio run -t uploadfs).");
  });
  server.begin();
  Serial.printf("[http] listening on :%u\n", HTTP_PORT);
}

void HttpApp::loop() {
  ws.cleanupClients();
  if (app_ && app_->leds.walking() && ws.count()) {
    uint8_t r = 0, c = 0;
    int led = -1;
    if (app_->leds.walkStep(r, c, led) && led != lastWalkLed_) {
      lastWalkLed_ = led;
      notifyWalk(r, c, led);
    }
  } else {
    lastWalkLed_ = -2;
  }
  if (millis() - lastStatus_ < STATUS_BROADCAST_MS) return;
  lastStatus_ = millis();
  if (!ws.count() || !app_) return;
  JsonDocument doc;
  doc["t"] = "status";
  fillStatus(app_, doc);
  String out;
  serializeJson(doc, out);
  ws.textAll(out);
}

void HttpApp::broadcast(const char* json) {
  if (ws.count()) ws.textAll(json);
}

void HttpApp::notifyDirty(const char* what) {
  JsonDocument doc;
  doc["t"] = "dirty";
  doc["what"] = what;
  String out;
  serializeJson(doc, out);
  broadcast(out.c_str());
}

void HttpApp::notifyWalk(uint8_t row, uint8_t col, int led) {
  JsonDocument doc;
  doc["t"] = "walk";
  doc["row"] = row;
  doc["col"] = col;
  doc["cell"] = app_ ? app_->rack.label(row, col) : cellLabel(row, col);
  doc["led"] = led;
  String out;
  serializeJson(doc, out);
  broadcast(out.c_str());
}

void HttpApp::registerRoutes() {
  server.on("/api/status", HTTP_GET, [this](AsyncWebServerRequest* req) {
    JsonDocument doc;
    fillStatus(app_, doc);
    sendJson(req, 200, doc);
  });

  server.on("/api/config", HTTP_GET, [this](AsyncWebServerRequest* req) {
    JsonDocument doc;
    app_->lock();
    fillConfig(app_, doc);
    app_->unlock();
    sendJson(req, 200, doc);
  });

  server.on(
      "/api/config", HTTP_PUT,
      [this](AsyncWebServerRequest* req) {
        JsonDocument doc;
        if (deserializeJson(doc, takeBody(req))) {
          sendErr(req, 400, "invalid json");
          return;
        }
        bool rebuild = false;
        app_->lock();
        app_->mergeConfig(doc.as<JsonVariantConst>(), rebuild);
        app_->applyConfig(rebuild);
        const bool ok = app_->saveConfig();
        fillConfig(app_, doc);
        app_->unlock();
        if (!ok) {
          sendErr(req, 500, "persist failed");
          return;
        }
        notifyDirty("config");
        sendJson(req, 200, doc);
      },
      nullptr, onBody);

  server.on("/api/inventory", HTTP_GET, [this](AsyncWebServerRequest* req) {
    JsonDocument doc;
    app_->lock();
    app_->inventory.toJson(doc);
    app_->unlock();
    sendJson(req, 200, doc);
  });

  server.on(
      "/api/inventory", HTTP_PUT,
      [this](AsyncWebServerRequest* req) {
        JsonDocument doc;
        if (deserializeJson(doc, takeBody(req))) {
          sendErr(req, 400, "invalid json");
          return;
        }
        app_->lock();
        app_->inventory.fromJson(doc.as<JsonVariantConst>());
        const bool ok = app_->saveInventory();
        app_->refreshStockLights();
        app_->inventory.toJson(doc);
        app_->unlock();
        if (!ok) {
          sendErr(req, 500, "persist failed");
          return;
        }
        notifyDirty("inventory");
        sendJson(req, 200, doc);
      },
      nullptr, onBody);

  server.on(
      "/api/stock/place", HTTP_POST,
      [this](AsyncWebServerRequest* req) {
        JsonDocument doc;
        if (deserializeJson(doc, takeBody(req))) {
          sendErr(req, 400, "invalid json");
          return;
        }
        uint8_t row = 0, col = 0;
        if (!readCell(app_, doc.as<JsonVariantConst>(), row, col)) {
          sendErr(req, 400, "bad cell");
          return;
        }
        Item proto;
        protoFromJson(proto, doc.as<JsonVariantConst>());
        if (!proto.name.length()) {
          sendErr(req, 400, "name required");
          return;
        }
        const int32_t qty = doc["qty"] | 1;
        app_->lock();
        Item* item = app_->inventory.place(proto, row, col, qty);
        app_->saveInventory();
        app_->refreshStockLights();
        if (item && app_->config.locateOnSelect) app_->leds.locate(row, col);
        JsonDocument out;
        if (item) {
          out["ok"] = true;
          out["id"] = item->id;
          out["cell"] = app_->rack.label(row, col);
          out["qty"] = qty;
        }
        app_->unlock();
        if (!item) {
          sendErr(req, 500, "place failed");
          return;
        }
        notifyDirty("inventory");
        sendJson(req, 200, out);
      },
      nullptr, onBody);

  server.on(
      "/api/stock/adjust", HTTP_POST,
      [this](AsyncWebServerRequest* req) {
        JsonDocument doc;
        if (deserializeJson(doc, takeBody(req))) {
          sendErr(req, 400, "invalid json");
          return;
        }
        uint8_t row = 0, col = 0;
        if (!readCell(app_, doc.as<JsonVariantConst>(), row, col)) {
          sendErr(req, 400, "bad cell");
          return;
        }
        const int32_t delta = doc["delta"] | 0;
        int32_t qty = 0;
        app_->lock();
        const bool ok = app_->inventory.adjust(row, col, delta, qty);
        if (ok) {
          app_->saveInventory();
          app_->refreshStockLights();
          app_->leds.flash(row, col, delta >= 0 ? 0x3DDC84 : 0xF5A524, 420);
        }
        app_->unlock();
        if (!ok) {
          sendErr(req, 404, "empty cell");
          return;
        }
        notifyDirty("inventory");
        JsonDocument out;
        out["ok"] = true;
        out["qty"] = qty;
        out["cell"] = app_->rack.label(row, col);
        sendJson(req, 200, out);
      },
      nullptr, onBody);

  server.on(
      "/api/stock/set", HTTP_POST,
      [this](AsyncWebServerRequest* req) {
        JsonDocument doc;
        if (deserializeJson(doc, takeBody(req))) {
          sendErr(req, 400, "invalid json");
          return;
        }
        uint8_t row = 0, col = 0;
        if (!readCell(app_, doc.as<JsonVariantConst>(), row, col)) {
          sendErr(req, 400, "bad cell");
          return;
        }
        int32_t qty = 0;
        app_->lock();
        const bool ok = app_->inventory.setQty(row, col, doc["qty"] | 0, qty);
        if (ok) {
          app_->saveInventory();
          app_->refreshStockLights();
        }
        app_->unlock();
        if (!ok) {
          sendErr(req, 404, "empty cell");
          return;
        }
        notifyDirty("inventory");
        JsonDocument out;
        out["ok"] = true;
        out["qty"] = qty;
        sendJson(req, 200, out);
      },
      nullptr, onBody);

  server.on(
      "/api/stock/clear", HTTP_POST,
      [this](AsyncWebServerRequest* req) {
        JsonDocument doc;
        if (deserializeJson(doc, takeBody(req))) {
          sendErr(req, 400, "invalid json");
          return;
        }
        uint8_t row = 0, col = 0;
        if (!readCell(app_, doc.as<JsonVariantConst>(), row, col)) {
          sendErr(req, 400, "bad cell");
          return;
        }
        app_->lock();
        const bool ok = app_->inventory.clearCell(row, col);
        if (ok) {
          app_->saveInventory();
          app_->refreshStockLights();
        }
        app_->unlock();
        if (!ok) {
          sendErr(req, 404, "empty cell");
          return;
        }
        notifyDirty("inventory");
        sendOk(req);
      },
      nullptr, onBody);

  server.on(
      "/api/stock/move", HTTP_POST,
      [this](AsyncWebServerRequest* req) {
        JsonDocument doc;
        if (deserializeJson(doc, takeBody(req))) {
          sendErr(req, 400, "invalid json");
          return;
        }
        uint8_t fr = 0, fc = 0, tr = 0, tc = 0;
        const bool a = doc["from"].is<const char*>()
                           ? app_->rack.parseLabel(doc["from"].as<const char*>(), fr, fc)
                           : false;
        const bool b = doc["to"].is<const char*>()
                           ? app_->rack.parseLabel(doc["to"].as<const char*>(), tr, tc)
                           : false;
        if (!a || !b) {
          sendErr(req, 400, "from/to required");
          return;
        }
        app_->lock();
        const bool ok = app_->inventory.move(fr, fc, tr, tc);
        if (ok) {
          app_->saveInventory();
          app_->refreshStockLights();
          if (app_->config.locateOnSelect) app_->leds.locate(tr, tc);
        }
        app_->unlock();
        if (!ok) {
          sendErr(req, 404, "move failed");
          return;
        }
        notifyDirty("inventory");
        sendOk(req);
      },
      nullptr, onBody);

  server.on(
      "/api/locate", HTTP_POST,
      [this](AsyncWebServerRequest* req) {
        JsonDocument doc;
        if (deserializeJson(doc, takeBody(req))) {
          sendErr(req, 400, "invalid json");
          return;
        }
        uint8_t row = 0, col = 0;
        if (!readCell(app_, doc.as<JsonVariantConst>(), row, col)) {
          sendErr(req, 400, "bad cell");
          return;
        }
        app_->leds.locate(row, col);
        JsonDocument out;
        out["ok"] = true;
        out["cell"] = app_->rack.label(row, col);
        out["led"] = app_->rack.ledFor(row, col);
        sendJson(req, 200, out);
      },
      nullptr, onBody);

  server.on(
      "/api/leds", HTTP_POST,
      [this](AsyncWebServerRequest* req) {
        JsonDocument doc;
        if (deserializeJson(doc, takeBody(req))) {
          sendErr(req, 400, "invalid json");
          return;
        }
        const char* mode = doc["mode"] | "idle";
        if (strcmp(mode, "idle") == 0) app_->leds.setIdle();
        else if (strcmp(mode, "off") == 0) app_->leds.off();
        else if (strcmp(mode, "startup") == 0) app_->leds.playStartup();
        else if (strcmp(mode, "corners") == 0) app_->leds.showCorners();
        else if (strcmp(mode, "walk") == 0) app_->leds.startWalk(doc["dwell"] | 280);
        else if (strcmp(mode, "stop") == 0) app_->leds.stopWalk();
        else if (strcmp(mode, "identify") == 0) {
          app_->leds.identifyLed(doc["index"] | 0);
        } else if (strcmp(mode, "locate") == 0) {
          uint8_t r = 0, c = 0;
          if (readCell(app_, doc.as<JsonVariantConst>(), r, c)) app_->leds.locate(r, c);
        } else {
          sendErr(req, 400, "unknown mode");
          return;
        }
        sendOk(req);
      },
      nullptr, onBody);

  server.on("/api/calibrate/walk-step", HTTP_GET, [this](AsyncWebServerRequest* req) {
    uint8_t r = 0, c = 0;
    int led = -1;
    JsonDocument doc;
    if (app_->leds.walking() && app_->leds.walkStep(r, c, led)) {
      doc["active"] = true;
      doc["row"] = r;
      doc["col"] = c;
      doc["cell"] = app_->rack.label(r, c);
      doc["led"] = led;
    } else {
      doc["active"] = false;
    }
    sendJson(req, 200, doc);
  });

  server.on("/api/catalog/remote", HTTP_GET, [this](AsyncWebServerRequest* req) {
    if (!req->hasParam("q")) {
      sendErr(req, 400, "q required");
      return;
    }
    if (!app_->config.remoteSearch) {
      JsonDocument doc;
      doc["q"] = req->getParam("q")->value();
      doc["items"].to<JsonArray>();
      doc["disabled"] = true;
      sendJson(req, 200, doc);
      return;
    }
    JsonDocument doc;
    String err;
    const String q = req->getParam("q")->value();
    const bool ok = app_->catalog.search(q, doc, err);
    if (!ok && err.length()) doc["error"] = err;
    sendJson(req, 200, doc);
  });

  server.on("/api/backup", HTTP_GET, [this](AsyncWebServerRequest* req) {
    JsonDocument doc;
    app_->lock();
    JsonDocument cfg;
    fillConfig(app_, cfg);
    doc["config"] = cfg.as<JsonVariantConst>();
    JsonDocument inv;
    app_->inventory.toJson(inv);
    doc["inventory"] = inv.as<JsonVariantConst>();
    doc["fw"] = FW_VERSION;
    app_->unlock();
    AsyncResponseStream* res = req->beginResponseStream("application/json");
    res->addHeader("Content-Disposition", "attachment; filename=\"rack-backup.json\"");
    serializeJson(doc, *res);
    req->send(res);
  });

  server.on(
      "/api/restore", HTTP_POST,
      [this](AsyncWebServerRequest* req) {
        JsonDocument doc;
        if (deserializeJson(doc, takeBody(req))) {
          sendErr(req, 400, "invalid json");
          return;
        }
        bool rebuild = false;
        app_->lock();
        if (!doc["config"].isNull()) app_->mergeConfig(doc["config"], rebuild);
        if (!doc["inventory"].isNull()) app_->inventory.fromJson(doc["inventory"]);
        app_->applyConfig(rebuild);
        app_->saveConfig();
        app_->saveInventory();
        app_->unlock();
        notifyDirty("config");
        notifyDirty("inventory");
        sendOk(req);
      },
      nullptr, onBody);

  server.on("/api/factory-reset", HTTP_POST, [this](AsyncWebServerRequest* req) {
    app_->lock();
    app_->store.remove("/config.json");
    app_->store.remove("/inventory.json");
    app_->config = AppConfig{};
    app_->inventory.clear();
    app_->applyConfig(true);
    app_->saveConfig();
    app_->saveInventory();
    app_->unlock();
    notifyDirty("config");
    notifyDirty("inventory");
    sendOk(req);
  });
}
