#include "Identity.h"

#include <Preferences.h>
#include <esp_random.h>

namespace {

String toHex(const uint8_t* bytes, size_t len) {
  static const char* kHex = "0123456789abcdef";
  String out;
  out.reserve(len * 2);
  for (size_t i = 0; i < len; i++) {
    out += kHex[bytes[i] >> 4];
    out += kHex[bytes[i] & 0x0F];
  }
  return out;
}

}  // namespace

void Identity::begin() {
  Preferences prefs;
  prefs.begin("rackid", false);

  rackId_ = prefs.getString("id", "");
  if (!rackId_.length()) {
    // The efuse MAC is unique per chip and survives a full flash erase, so a
    // reflashed board keeps its database rows.
    uint8_t mac[6] = {0};
    const uint64_t efuse = ESP.getEfuseMac();
    for (int i = 0; i < 6; i++) mac[i] = static_cast<uint8_t>(efuse >> (8 * i));
    rackId_ = toHex(mac, sizeof(mac));
    prefs.putString("id", rackId_);
  }

  secret_ = prefs.getString("secret", "");
  if (secret_.length() != 32) {
    uint8_t key[16];
    // Hardware RNG. Properly seeded here because the radio is already up.
    esp_fill_random(key, sizeof(key));
    secret_ = toHex(key, sizeof(key));
    prefs.putString("secret", secret_);
    Serial.println("[id] generated new rack secret");
  }

  prefs.end();
  Serial.printf("[id] rack %s\n", rackId_.c_str());
}
