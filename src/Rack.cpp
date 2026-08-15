#include "Rack.h"

uint8_t RackModel::rows() const {
  return cfg_ ? cfg_->rows : DEFAULT_ROWS;
}

uint8_t RackModel::cols() const {
  return cfg_ ? cfg_->cols : DEFAULT_COLS;
}

int RackModel::cellCount() const {
  return static_cast<int>(rows()) * static_cast<int>(cols());
}

bool RackModel::inBounds(int row, int col) const {
  return row >= 0 && col >= 0 && row < rows() && col < cols();
}

int RackModel::ledFor(uint8_t row, uint8_t col) const {
  if (!cfg_ || !inBounds(row, col)) return -1;

  const uint16_t key = cellIndex(row, col, cfg_->cols);
  auto it = cfg_->overrides.find(key);
  if (it != cfg_->overrides.end()) {
    return it->second;
  }

  int r = row;
  int c = col;
  const int R = cfg_->rows;
  const int C = cfg_->cols;

  switch (cfg_->origin) {
    case WiringOrigin::TopRight:
      c = C - 1 - c;
      break;
    case WiringOrigin::BottomLeft:
      r = R - 1 - r;
      break;
    case WiringOrigin::BottomRight:
      r = R - 1 - r;
      c = C - 1 - c;
      break;
    case WiringOrigin::TopLeft:
    default:
      break;
  }

  int idx;
  if (cfg_->rowFirst) {
    if (cfg_->serpentine && (r % 2)) c = C - 1 - c;
    idx = r * C + c;
  } else {
    if (cfg_->serpentine && (c % 2)) r = R - 1 - r;
    idx = c * R + r;
  }

  idx += cfg_->ledOffset;
  if (idx < 0 || idx >= static_cast<int>(cfg_->ledCount)) return -1;
  return idx;
}

bool RackModel::cellForLed(int led, uint8_t& row, uint8_t& col) const {
  if (!cfg_) return false;
  for (uint8_t r = 0; r < cfg_->rows; r++) {
    for (uint8_t c = 0; c < cfg_->cols; c++) {
      if (ledFor(r, c) == led) {
        row = r;
        col = c;
        return true;
      }
    }
  }
  return false;
}

String RackModel::label(uint8_t row, uint8_t col) const {
  return cellLabel(row, col);
}

bool RackModel::parseLabel(const String& raw, uint8_t& row, uint8_t& col) const {
  return parseCellLabel(raw, rows(), cols(), row, col);
}
