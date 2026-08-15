#include "WifiStation.h"

#include <ESPmDNS.h>
#include <WiFi.h>

#include "Config.h"
#include "secrets.h"

void WifiStation::begin(const std::function<void()>& pump) {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setHostname(MDNS_HOSTNAME);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[wifi] connecting to %s\n", WIFI_SSID);

  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
    delay(20);
    if (pump) pump();
    if ((millis() - start) % 200 < 25) Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    apMode_ = false;
    Serial.printf("[wifi] ip %s  rssi %d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    Serial.println("[wifi] station failed — starting fallback AP");
    startAp();
  }

  if (MDNS.begin(MDNS_HOSTNAME)) {
    MDNS.addService("http", "tcp", HTTP_PORT);
    Serial.printf("[wifi] http://%s.local:%u\n", MDNS_HOSTNAME, HTTP_PORT);
  }
}

void WifiStation::startAp() {
  WiFi.mode(WIFI_AP);
  const String ssid = String("RACK-") + String((uint32_t)ESP.getEfuseMac(), HEX);
  // Open AP so a bad hard-coded password never bricks the UI.
  WiFi.softAP(ssid.c_str());
  apMode_ = true;
  Serial.printf("[wifi] AP %s  ip %s\n", ssid.c_str(), WiFi.softAPIP().toString().c_str());
}

void WifiStation::loop() {
  if (apMode_) return;
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastAttempt_ < 8000) return;
  lastAttempt_ = millis();
  Serial.println("[wifi] reconnect");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

bool WifiStation::connected() const {
  return !apMode_ && WiFi.status() == WL_CONNECTED;
}

String WifiStation::ip() const {
  return apMode_ ? WiFi.softAPIP().toString() : WiFi.localIP().toString();
}

String WifiStation::ssid() const {
  return apMode_ ? WiFi.softAPSSID() : String(WIFI_SSID);
}

int WifiStation::rssi() const {
  return apMode_ ? 0 : WiFi.RSSI();
}

String WifiStation::mac() const {
  return WiFi.macAddress();
}
