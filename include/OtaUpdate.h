#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <functional>

class OtaUpdate {
public:
  enum class State : uint8_t { Idle, Checking, Ready, Updating, Success, Error };

  using Emit = std::function<void(const char* json)>;

  void begin(Emit emit);
  void loop();
  void requestCheck();
  void requestInstall();

  void toJson(JsonDocument& doc) const;

  State state() const { return state_; }
  bool busy() const { return state_ == State::Checking || state_ == State::Updating; }

private:
  void doCheck();
  void doInstall();
  void setState(State s, const char* msg);
  void emit();
  bool httpsGet(const char* url, String& body, String& err, uint16_t timeoutMs);

  Emit emit_;
  State state_ = State::Idle;
  bool wantCheck_ = false;
  bool wantInstall_ = false;
  String message_ = "idle";
  String latestVersion_;
  String latestGit_;
  String latestBuilt_;
  int progress_ = 0;
  String phase_;
};
