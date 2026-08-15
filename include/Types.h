#pragma once

#include <Arduino.h>
#include <map>
#include <vector>

#include "Config.h"

enum class ColorOrder : uint8_t { GRB = 0, RGB, BRG, RBG, GBR, BGR };
enum class WiringOrigin : uint8_t { TopLeft = 0, TopRight, BottomLeft, BottomRight };
enum class IdleAnim : uint8_t { Off = 0, DimStock, Breathe, Sparkle, Rainbow, Heatmap };
enum class StartupAnim : uint8_t { None = 0, Cascade, Spiral, Lightning };
enum class LedMode : uint8_t {
  Startup = 0,
  Idle,
  Locate,
  Flash,
  Identify,
  Walk,
  Corners,
  Off
};

struct StockLoc {
  uint8_t row = 0;
  uint8_t col = 0;
  int32_t qty = 0;
};

struct Item {
  String id;
  String name;
  String mpn;
  String sku;
  String category;
  String pkg;
  String brand;
  String notes;
  String source;
  uint32_t color = 0xE6A15C;
  std::vector<StockLoc> locs;
};

struct CellLight {
  uint8_t row = 0;
  uint8_t col = 0;
  uint32_t color = 0;
  int32_t qty = 0;
  bool occupied = false;
};

struct AppConfig {
  uint8_t version = 1;
  String rackName = "Bench Rack";

  uint8_t rows = DEFAULT_ROWS;
  uint8_t cols = DEFAULT_COLS;

  uint8_t ledPin = DEFAULT_LED_PIN;
  uint16_t ledCount = DEFAULT_LED_COUNT;
  ColorOrder order = ColorOrder::GRB;
  uint8_t brightness = DEFAULT_BRIGHTNESS;
  uint8_t idleBrightness = DEFAULT_IDLE_BRIGHTNESS;
  uint32_t locateColor = 0x3DD6E0;
  IdleAnim idleAnim = IdleAnim::Breathe;
  StartupAnim startupAnim = StartupAnim::Cascade;

  WiringOrigin origin = WiringOrigin::TopLeft;
  bool rowFirst = true;
  bool serpentine = true;
  int16_t ledOffset = 0;
  // cellIndex (row * cols + col) -> absolute LED index
  std::map<uint16_t, int16_t> overrides;

  bool locateOnSelect = true;
  uint16_t locateHoldMs = 0;  // 0 = hold until next action
  int32_t lowStockQty = 5;
  bool remoteSearch = true;

  void clamp();
};

inline uint16_t cellIndex(uint8_t row, uint8_t col, uint8_t cols) {
  return static_cast<uint16_t>(row) * cols + col;
}

const char* colorOrderName(ColorOrder o);
bool colorOrderFromName(const char* s, ColorOrder& out);
const char* originName(WiringOrigin o);
bool originFromName(const char* s, WiringOrigin& out);
const char* idleAnimName(IdleAnim a);
bool idleAnimFromName(const char* s, IdleAnim& out);
const char* startupAnimName(StartupAnim a);
bool startupAnimFromName(const char* s, StartupAnim& out);

uint32_t categoryColor(const String& category);
String cellLabel(uint8_t row, uint8_t col);
bool parseCellLabel(const String& raw, uint8_t rows, uint8_t cols, uint8_t& row, uint8_t& col);
String newItemId();
uint32_t parseHexColor(const char* s, uint32_t fallback);
String hexColor(uint32_t c);
