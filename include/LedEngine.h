#pragma once

#include "Rack.h"
#include "Types.h"

class Adafruit_NeoPixel;

class LedEngine {
public:
  ~LedEngine();

  void begin(const AppConfig& cfg, const RackModel* rack);
  void applyHardware(const AppConfig& cfg);  // pin / count / order
  void bindRack(const RackModel* rack) { rack_ = rack; }
  void setConfig(const AppConfig& cfg);

  void loop();

  void playStartup();
  void setIdle();
  void off();
  void locate(uint8_t row, uint8_t col);
  void flash(uint8_t row, uint8_t col, uint32_t color, uint16_t ms);
  void identifyLed(int index);
  void showCorners();
  void startWalk(uint16_t dwellMs = 280);
  void stopWalk();

  void setStock(const std::vector<CellLight>& stock);

  LedMode mode() const { return mode_; }
  bool walking() const { return mode_ == LedMode::Walk; }
  bool walkStep(uint8_t& row, uint8_t& col, int& led);

private:
  void rebuild();
  void render();
  void setPixelRgb(int index, uint8_t r, uint8_t g, uint8_t b, uint8_t scale);
  void cellColor(uint8_t row, uint8_t col, uint8_t& r, uint8_t& g, uint8_t& b) const;
  const CellLight* stockAt(uint8_t row, uint8_t col) const;

  Adafruit_NeoPixel* strip_ = nullptr;
  const RackModel* rack_ = nullptr;
  AppConfig cfg_{};
  LedMode mode_ = LedMode::Startup;
  uint32_t modeStart_ = 0;
  uint32_t lastFrame_ = 0;
  uint8_t locRow_ = 0;
  uint8_t locCol_ = 0;
  uint32_t flashColor_ = 0;
  uint16_t flashMs_ = 400;
  int identifyIndex_ = 0;
  uint16_t walkDwell_ = 280;
  uint16_t walkPos_ = 0;
  std::vector<CellLight> stock_;
};
