#include "Types.h"

#include <stdlib.h>

void AppConfig::clamp() {
  if (rows < 1) rows = 1;
  if (cols < 1) cols = 1;
  if (rows > MAX_ROWS) rows = MAX_ROWS;
  if (cols > MAX_COLS) cols = MAX_COLS;
  if (ledCount < 1) ledCount = 1;
  if (ledCount > MAX_LEDS) ledCount = MAX_LEDS;
  if (ledPin > 39) ledPin = DEFAULT_LED_PIN;
  if (brightness < 1) brightness = 1;
  if (idleBrightness < 1) idleBrightness = 1;
  if (lowStockQty < 0) lowStockQty = 0;
}

static bool eqi(const char* a, const char* b) {
  if (!a || !b) return false;
  return strcasecmp(a, b) == 0;
}

const char* colorOrderName(ColorOrder o) {
  switch (o) {
    case ColorOrder::RGB: return "RGB";
    case ColorOrder::BRG: return "BRG";
    case ColorOrder::RBG: return "RBG";
    case ColorOrder::GBR: return "GBR";
    case ColorOrder::BGR: return "BGR";
    default: return "GRB";
  }
}

bool colorOrderFromName(const char* s, ColorOrder& out) {
  if (eqi(s, "RGB")) { out = ColorOrder::RGB; return true; }
  if (eqi(s, "GRB")) { out = ColorOrder::GRB; return true; }
  if (eqi(s, "BRG")) { out = ColorOrder::BRG; return true; }
  if (eqi(s, "RBG")) { out = ColorOrder::RBG; return true; }
  if (eqi(s, "GBR")) { out = ColorOrder::GBR; return true; }
  if (eqi(s, "BGR")) { out = ColorOrder::BGR; return true; }
  return false;
}

const char* originName(WiringOrigin o) {
  switch (o) {
    case WiringOrigin::TopRight: return "top-right";
    case WiringOrigin::BottomLeft: return "bottom-left";
    case WiringOrigin::BottomRight: return "bottom-right";
    default: return "top-left";
  }
}

bool originFromName(const char* s, WiringOrigin& out) {
  if (eqi(s, "top-left") || eqi(s, "tl")) { out = WiringOrigin::TopLeft; return true; }
  if (eqi(s, "top-right") || eqi(s, "tr")) { out = WiringOrigin::TopRight; return true; }
  if (eqi(s, "bottom-left") || eqi(s, "bl")) { out = WiringOrigin::BottomLeft; return true; }
  if (eqi(s, "bottom-right") || eqi(s, "br")) { out = WiringOrigin::BottomRight; return true; }
  return false;
}

const char* idleAnimName(IdleAnim a) {
  switch (a) {
    case IdleAnim::Off: return "off";
    case IdleAnim::DimStock: return "dim-stock";
    case IdleAnim::Sparkle: return "sparkle";
    case IdleAnim::Rainbow: return "rainbow";
    case IdleAnim::Heatmap: return "heatmap";
    default: return "breathe";
  }
}

bool idleAnimFromName(const char* s, IdleAnim& out) {
  if (eqi(s, "off")) { out = IdleAnim::Off; return true; }
  if (eqi(s, "dim-stock") || eqi(s, "dim")) { out = IdleAnim::DimStock; return true; }
  if (eqi(s, "breathe")) { out = IdleAnim::Breathe; return true; }
  if (eqi(s, "sparkle")) { out = IdleAnim::Sparkle; return true; }
  if (eqi(s, "rainbow")) { out = IdleAnim::Rainbow; return true; }
  if (eqi(s, "heatmap")) { out = IdleAnim::Heatmap; return true; }
  return false;
}

const char* startupAnimName(StartupAnim a) {
  switch (a) {
    case StartupAnim::None: return "none";
    case StartupAnim::Spiral: return "spiral";
    case StartupAnim::Lightning: return "lightning";
    default: return "cascade";
  }
}

bool startupAnimFromName(const char* s, StartupAnim& out) {
  if (eqi(s, "none") || eqi(s, "off")) { out = StartupAnim::None; return true; }
  if (eqi(s, "cascade")) { out = StartupAnim::Cascade; return true; }
  if (eqi(s, "spiral")) { out = StartupAnim::Spiral; return true; }
  if (eqi(s, "lightning")) { out = StartupAnim::Lightning; return true; }
  return false;
}

uint32_t categoryColor(const String& category) {
  String c = category;
  c.toLowerCase();
  if (c == "resistor") return 0xE6A15C;
  if (c == "capacitor") return 0x5B9DFF;
  if (c == "inductor") return 0x7C6BFF;
  if (c == "diode") return 0xF0C14B;
  if (c == "led") return 0xFF6B8A;
  if (c == "transistor") return 0x4FD1A5;
  if (c == "ic") return 0xC084FC;
  if (c == "mcu") return 0xA78BFA;
  if (c == "board") return 0x22D3EE;
  if (c == "sensor") return 0x34D399;
  if (c == "connector") return 0xFB7185;
  if (c == "module") return 0x67E8F9;
  if (c == "tool") return 0xF5D0A9;
  if (c == "chemical") return 0xFDE68A;
  if (c == "wire") return 0xFBBF24;
  if (c == "display") return 0x93C5FD;
  if (c == "power") return 0xF87171;
  if (c == "mechanical") return 0xA8A29E;
  return 0xE6A15C;
}

String cellLabel(uint8_t row, uint8_t col) {
  String colS;
  int c = static_cast<int>(col) + 1;
  while (c > 0) {
    int rem = (c - 1) % 26;
    colS = String(char('A' + rem)) + colS;
    c = (c - 1) / 26;
  }
  return colS + String(row + 1);
}

bool parseCellLabel(const String& raw, uint8_t rows, uint8_t cols, uint8_t& row, uint8_t& col) {
  String s = raw;
  s.trim();
  s.toUpperCase();
  if (s.length() < 2) return false;

  // "r,c" or "r:c"
  int sep = s.indexOf(',');
  if (sep < 0) sep = s.indexOf(':');
  if (sep > 0) {
    int r = s.substring(0, sep).toInt();
    int c = s.substring(sep + 1).toInt();
    if (r >= 0 && c >= 0 && r < rows && c < cols) {
      row = static_cast<uint8_t>(r);
      col = static_cast<uint8_t>(c);
      return true;
    }
    return false;
  }

  int i = 0;
  int colAcc = 0;
  while (i < s.length() && s[i] >= 'A' && s[i] <= 'Z') {
    colAcc = colAcc * 26 + (s[i] - 'A' + 1);
    i++;
  }
  if (i == 0 || i >= s.length()) return false;
  int r1 = s.substring(i).toInt();
  if (r1 < 1) return false;
  int r = r1 - 1;
  int c = colAcc - 1;
  if (r < 0 || c < 0 || r >= rows || c >= cols) return false;
  row = static_cast<uint8_t>(r);
  col = static_cast<uint8_t>(c);
  return true;
}

String newItemId() {
  char buf[12];
  uint32_t n = (esp_random() ^ millis()) & 0xFFFFFF;
  snprintf(buf, sizeof(buf), "%06x", n);
  return String(buf);
}

uint32_t parseHexColor(const char* s, uint32_t fallback) {
  if (!s || !*s) return fallback;
  if (s[0] == '#') s++;
  char* end = nullptr;
  unsigned long v = strtoul(s, &end, 16);
  if (end == s) return fallback;
  return static_cast<uint32_t>(v & 0xFFFFFFu);
}

String hexColor(uint32_t c) {
  char buf[8];
  snprintf(buf, sizeof(buf), "#%06X", c & 0xFFFFFFu);
  return String(buf);
}
