#pragma once

#include "Types.h"

class RackModel {
public:
  void bind(const AppConfig* cfg) { cfg_ = cfg; }

  uint8_t rows() const;
  uint8_t cols() const;
  int cellCount() const;
  bool inBounds(int row, int col) const;

  // -1 if the cell maps outside the configured strip
  int ledFor(uint8_t row, uint8_t col) const;
  // Inverse: first cell that maps to this LED, or false
  bool cellForLed(int led, uint8_t& row, uint8_t& col) const;

  String label(uint8_t row, uint8_t col) const;
  bool parseLabel(const String& raw, uint8_t& row, uint8_t& col) const;

private:
  const AppConfig* cfg_ = nullptr;
};
