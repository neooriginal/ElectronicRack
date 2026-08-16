#include "OtaUpdate.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "Config.h"

namespace {

OtaUpdate* gOta = nullptr;

const char* stateName(OtaUpdate::State s) {
  switch (s) {
    case OtaUpdate::State::Checking: return "checking";
    case OtaUpdate::State::Ready: return "ready";
    case OtaUpdate::State::Updating: return "updating";
    case OtaUpdate::State::Success: return "success";
    case OtaUpdate::State::Error: return "error";
    default: return "idle";
  }
}

}  // namespace

void OtaUpdate::begin(Emit emit) {
  emit_ = std::move(emit);
  gOta = this;
}

void OtaUpdate::loop() {
  if (wantCheck_ && !busy()) {
    wantCheck_ = false;
    doCheck();
  }
  if (wantInstall_ && state_ != State::Updating) {
    wantInstall_ = false;
    doInstall();
  }
}

void OtaUpdate::requestCheck() {
  if (busy()) return;
  wantCheck_ = true;
}

void OtaUpdate::requestInstall() {
  if (state_ == State::Updating) return;
  wantInstall_ = true;
}

void OtaUpdate::toJson(JsonDocument& doc) const {
  doc["state"] = stateName(state_);
  doc["message"] = message_;
  doc["progress"] = progress_;
  doc["phase"] = phase_;
  doc["repo"] = GITHUB_REPO;
  doc["current"]["version"] = FW_VERSION;
  doc["current"]["git"] = FW_GIT;
  doc["latest"]["version"] = latestVersion_;
  doc["latest"]["git"] = latestGit_;
  doc["latest"]["built"] = latestBuilt_;
  const bool have = latestGit_.length() > 0;
  doc["available"] = have && latestGit_ != String(FW_GIT);
}

void OtaUpdate::setState(State s, const char* msg) {
  state_ = s;
  if (msg) message_ = msg;
  emit();
}

void OtaUpdate::emit() {
  if (!emit_) return;
  JsonDocument doc;
  doc["t"] = "ota";
  toJson(doc);
  String out;
  serializeJson(doc, out);
  emit_(out.c_str());
}

bool OtaUpdate::httpsGet(const char* url, String& body, String& err, uint16_t timeoutMs) {
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
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
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

void OtaUpdate::doCheck() {
  setState(State::Checking, "checking GitHub");
  phase_ = "manifest";
  progress_ = 0;
  emit();

  String body, err;
  if (!httpsGet(OTA_VERSION_URL, body, err, 12000)) {
    setState(State::Error, err.c_str());
    return;
  }
  JsonDocument doc;
  if (deserializeJson(doc, body)) {
    setState(State::Error, "bad version.json");
    return;
  }
  latestVersion_ = doc["version"] | "";
  latestGit_ = doc["git"] | "";
  latestBuilt_ = doc["built"] | "";
  if (!latestGit_.length()) {
    setState(State::Error, "version.json missing git");
    return;
  }
  if (latestGit_ == String(FW_GIT)) {
    setState(State::Idle, "up to date");
  } else {
    setState(State::Ready, "update available");
  }
}

void OtaUpdate::doInstall() {
  if (WiFi.status() != WL_CONNECTED) {
    setState(State::Error, "wifi down");
    return;
  }

  setState(State::Updating, "starting");
  progress_ = 0;

  httpUpdate.rebootOnUpdate(false);
  httpUpdate.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  httpUpdate.onProgress([](int cur, int total) {
    if (!gOta || total <= 0) return;
    gOta->progress_ = (cur * 100) / total;
    gOta->emit();
  });

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(120);

  phase_ = "filesystem";
  message_ = "writing UI";
  progress_ = 0;
  emit();
  t_httpUpdate_return fsRet = httpUpdate.updateSpiffs(client, OTA_FS_URL);
  if (fsRet != HTTP_UPDATE_OK) {
    String err = httpUpdate.getLastErrorString();
    if (!err.length()) err = String("filesystem update failed (") + (int)fsRet + ")";
    setState(State::Error, err.c_str());
    return;
  }

  phase_ = "firmware";
  message_ = "writing firmware";
  progress_ = 0;
  emit();
  t_httpUpdate_return fwRet = httpUpdate.update(client, OTA_FIRMWARE_URL);
  if (fwRet != HTTP_UPDATE_OK) {
    String err = httpUpdate.getLastErrorString();
    if (!err.length()) err = String("firmware update failed (") + (int)fwRet + ")";
    setState(State::Error, err.c_str());
    return;
  }

  progress_ = 100;
  phase_ = "reboot";
  setState(State::Success, "rebooting");
  delay(400);
  ESP.restart();
}
