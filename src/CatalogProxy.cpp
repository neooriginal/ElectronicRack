#include "CatalogProxy.h"

#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <cctype>

#include "Config.h"
#include "Types.h"

namespace {

String urlEncode(const String& s) {
  String o;
  o.reserve(s.length() * 3);
  for (size_t i = 0; i < s.length(); i++) {
    const char c = s[i];
    if (isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_' || c == '.' || c == '~') {
      o += c;
    } else if (c == ' ') {
      o += "%20";
    } else {
      char buf[4];
      snprintf(buf, sizeof(buf), "%%%02X", static_cast<unsigned char>(c));
      o += buf;
    }
  }
  return o;
}

String inferCategory(const String& type, const String& name) {
  String t = type + " " + name;
  t.toLowerCase();
  if (t.indexOf("resistor") >= 0) return "resistor";
  if (t.indexOf("capacitor") >= 0 || t.indexOf("cap ") >= 0) return "capacitor";
  if (t.indexOf("inductor") >= 0) return "inductor";
  if (t.indexOf("diode") >= 0 || t.indexOf("schottky") >= 0 || t.indexOf("zener") >= 0) return "diode";
  if (t.indexOf("led") >= 0 || t.indexOf("light emitting") >= 0) return "led";
  if (t.indexOf("mosfet") >= 0 || t.indexOf("transistor") >= 0 || t.indexOf("bjt") >= 0) return "transistor";
  if (t.indexOf("mcu") >= 0 || t.indexOf("microcontroller") >= 0 || t.indexOf("esp32") >= 0 ||
      t.indexOf("stm32") >= 0)
    return "mcu";
  if (t.indexOf("sensor") >= 0) return "sensor";
  if (t.indexOf("connector") >= 0 || t.indexOf("header") >= 0) return "connector";
  if (t.indexOf("module") >= 0 || t.indexOf("wroom") >= 0) return "module";
  if (t.indexOf("display") >= 0 || t.indexOf("oled") >= 0 || t.indexOf("lcd") >= 0) return "display";
  if (t.indexOf("regulator") >= 0 || t.indexOf("pmic") >= 0) return "power";
  if (t.indexOf("ic") >= 0 || t.indexOf("integrated") >= 0) return "ic";
  return "other";
}

void pushItem(JsonArray arr, const String& name, const String& mpn, const String& pkg,
              const String& category, const String& brand, const String& source,
              const String& sku) {
  if (!name.length() && !mpn.length()) return;
  JsonObject o = arr.add<JsonObject>();
  o["name"] = name.length() ? name : mpn;
  o["mpn"] = mpn;
  o["package"] = pkg;
  o["category"] = category;
  o["brand"] = brand;
  o["source"] = source;
  o["sku"] = sku;
  o["color"] = hexColor(categoryColor(category));
}

bool httpGet(const String& url, String& body, String& err, uint16_t timeoutMs) {
  if (WiFi.status() != WL_CONNECTED) {
    err = "wifi down";
    return false;
  }
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(timeoutMs / 1000);
  HTTPClient http;
  http.setConnectTimeout(timeoutMs);
  http.setTimeout(timeoutMs);
  http.setReuse(false);
  if (!http.begin(client, url)) {
    err = "begin failed";
    return false;
  }
  http.addHeader("Accept", "application/json");
  http.setUserAgent("ElectronicRack/" FW_VERSION);
  const int code = http.GET();
  if (code != 200) {
    err = String("HTTP ") + code;
    http.end();
    return false;
  }
  body = http.getString();
  http.end();
  return body.length() > 0;
}

bool httpPost(const String& url, const String& payload, String& body, String& err, uint16_t timeoutMs) {
  if (WiFi.status() != WL_CONNECTED) {
    err = "wifi down";
    return false;
  }
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(timeoutMs / 1000);
  HTTPClient http;
  http.setConnectTimeout(timeoutMs);
  http.setTimeout(timeoutMs);
  http.setReuse(false);
  if (!http.begin(client, url)) {
    err = "begin failed";
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Accept", "application/json");
  http.setUserAgent("ElectronicRack/" FW_VERSION);
  const int code = http.POST(payload);
  if (code != 200) {
    err = String("HTTP ") + code;
    http.end();
    return false;
  }
  body = http.getString();
  http.end();
  return body.length() > 0;
}

bool parseJlcSearch(const String& body, JsonArray dest) {
  JsonDocument filter;
  filter["components"][0]["lcsc"] = true;
  filter["components"][0]["mfr"] = true;
  filter["components"][0]["package"] = true;
  filter["components"][0]["description"] = true;
  JsonDocument doc;
  DeserializationError e = deserializeJson(doc, body, DeserializationOption::Filter(filter));
  if (e) return false;
  JsonArrayConst comps = doc["components"].as<JsonArrayConst>();
  if (comps.isNull()) return false;
  int n = 0;
  for (JsonVariantConst c : comps) {
    if (n++ >= REMOTE_SEARCH_LIMIT) break;
    String mpn = c["mfr"] | "";
    String pkg = c["package"] | "";
    String desc = c["description"] | "";
    String sku;
    if (c["lcsc"].is<int>()) sku = String("C") + String(c["lcsc"].as<int>());
    else sku = c["lcsc"] | "";
    const String name = desc.length() ? (mpn.length() ? mpn + " — " + desc : desc) : mpn;
    const String cat = inferCategory(desc, mpn);
    pushItem(dest, name, mpn, pkg, cat, "", "jlcsearch", sku);
  }
  return dest.size() > 0;
}

bool parseJlcPcb(const String& body, JsonArray dest) {
  JsonDocument filter;
  JsonObject row = filter["data"]["componentPageInfo"]["list"][0].to<JsonObject>();
  row["componentCode"] = true;
  row["componentModelEn"] = true;
  row["componentName"] = true;
  row["componentBrandEn"] = true;
  row["componentSpecificationEn"] = true;
  row["componentTypeEn"] = true;
  JsonDocument doc;
  DeserializationError e = deserializeJson(doc, body, DeserializationOption::Filter(filter));
  if (e) return false;
  JsonArrayConst list = doc["data"]["componentPageInfo"]["list"].as<JsonArrayConst>();
  if (list.isNull()) return false;
  int n = 0;
  for (JsonVariantConst c : list) {
    if (n++ >= REMOTE_SEARCH_LIMIT) break;
    String mpn = c["componentModelEn"] | "";
    String name = c["componentName"] | mpn;
    String pkg = c["componentSpecificationEn"] | "";
    String brand = c["componentBrandEn"] | "";
    String type = c["componentTypeEn"] | "";
    String sku = c["componentCode"] | "";
    pushItem(dest, name, mpn, pkg, inferCategory(type, name), brand, "jlcpcb", sku);
  }
  return dest.size() > 0;
}

}  // namespace

bool CatalogProxy::search(const String& query, JsonDocument& out, String& err) {
  out.clear();
  out["q"] = query;
  JsonArray items = out["items"].to<JsonArray>();
  JsonArray sources = out["sources"].to<JsonArray>();

  String q = query;
  q.trim();
  if (q.length() < 1) {
    err = "empty query";
    return false;
  }

  String body;
  String e1;
  const String url = String("https://jlcsearch.tscircuit.com/api/search?q=") + urlEncode(q) +
                     "&limit=" + String(REMOTE_SEARCH_LIMIT);
  if (httpGet(url, body, e1, REMOTE_SEARCH_TIMEOUT_MS) && parseJlcSearch(body, items)) {
    sources.add("jlcsearch");
  }

  if (items.size() == 0) {
    JsonDocument payloadDoc;
    payloadDoc["keyword"] = q;
    payloadDoc["currentPage"] = 1;
    payloadDoc["pageSize"] = REMOTE_SEARCH_LIMIT;
    String payload;
    serializeJson(payloadDoc, payload);
    String e2;
    if (httpPost("https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList",
                 payload, body, e2, REMOTE_SEARCH_TIMEOUT_MS) &&
        parseJlcPcb(body, items)) {
      sources.add("jlcpcb");
    } else if (e1.length() || e2.length()) {
      err = e1.length() ? e1 : e2;
    }
  }

  out["count"] = items.size();
  return items.size() > 0;
}
