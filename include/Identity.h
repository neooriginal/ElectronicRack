#pragma once

#include <Arduino.h>

// Who this rack is, and the credential that scopes its rows in the server's
// database. Generated once on first boot and kept in NVS for the life of the
// board — the browser cannot supply it, because Web Bluetooth never exposes a
// peer's MAC address.
class Identity {
public:
  void begin();

  // Stable across reboots and reflashes. Derived from the efuse MAC.
  const String& rackId() const { return rackId_; }
  // 128 random bits, hex. Readable by anything within BLE range, so proximity
  // is the trust boundary.
  const String& secret() const { return secret_; }

private:
  String rackId_;
  String secret_;
};
