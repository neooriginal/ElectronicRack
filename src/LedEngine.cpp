#include "LedEngine.h"

#include <Adafruit_NeoPixel.h>
#include <math.h>

namespace {

void unpack(uint32_t c, uint8_t& r, uint8_t& g, uint8_t& b) {
  r = (c >> 16) & 0xFF;
  g = (c >> 8) & 0xFF;
  b = c & 0xFF;
}

uint8_t lerp8(uint8_t a, uint8_t b, float t) {
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return static_cast<uint8_t>(a + (b - a) * t);
}

float frac(float x) {
  return x - floorf(x);
}

int spiralIndex(int row, int col, int rows, int cols) {
  int layer = min(min(row, col), min(rows - 1 - row, cols - 1 - col));
  int idx = 0;
  int r0 = 0, c0 = 0, r1 = rows - 1, c1 = cols - 1;
  for (int l = 0; l < layer; l++) {
    int h = c1 - c0 + 1;
    int v = r1 - r0 + 1;
    if (h <= 0 || v <= 0) break;
    idx += h * 2 + max(0, v - 2) * 2;
    r0++;
    c0++;
    r1--;
    c1--;
  }
  const int top = c1 - c0 + 1;
  if (row == r0) return idx + (col - c0);
  idx += top;
  const int right = r1 - r0;
  if (col == c1) return idx + (row - r0 - 1);
  idx += max(0, right);
  const int bot = c1 - c0;
  if (row == r1) return idx + (c1 - col - 1);
  idx += max(0, bot);
  return idx + (r1 - row - 1);
}

neoPixelType neoType(ColorOrder order) {
  switch (order) {
    case ColorOrder::RGB: return NEO_RGB + NEO_KHZ800;
    case ColorOrder::BRG: return NEO_BRG + NEO_KHZ800;
    case ColorOrder::RBG: return NEO_RBG + NEO_KHZ800;
    case ColorOrder::GBR: return NEO_GBR + NEO_KHZ800;
    case ColorOrder::BGR: return NEO_BGR + NEO_KHZ800;
    default: return NEO_GRB + NEO_KHZ800;
  }
}

}  // namespace

LedEngine::~LedEngine() {
  delete strip_;
}

void LedEngine::begin(const AppConfig& cfg, const RackModel* rack) {
  rack_ = rack;
  cfg_ = cfg;
  rebuild();
  playStartup();
}

void LedEngine::applyHardware(const AppConfig& cfg) {
  const bool rebuildHw =
      !strip_ || cfg.ledPin != cfg_.ledPin || cfg.ledCount != cfg_.ledCount || cfg.order != cfg_.order;
  cfg_ = cfg;
  if (rebuildHw) rebuild();
}

void LedEngine::setConfig(const AppConfig& cfg) {
  applyHardware(cfg);
}

void LedEngine::rebuild() {
  delete strip_;
  strip_ = new Adafruit_NeoPixel(cfg_.ledCount, cfg_.ledPin, neoType(cfg_.order));
  strip_->begin();
  strip_->setBrightness(255);
  strip_->clear();
  strip_->show();
  Serial.printf("[led] pin=%u count=%u order=%s\n", cfg_.ledPin, cfg_.ledCount,
                colorOrderName(cfg_.order));
}

void LedEngine::loop() {
  const uint32_t now = millis();
  if (now - lastFrame_ < LED_FRAME_MS) return;
  lastFrame_ = now;

  if (mode_ == LedMode::Flash && now - modeStart_ >= flashMs_) {
    setIdle();
  }
  if (mode_ == LedMode::Locate && cfg_.locateHoldMs > 0 && now - modeStart_ >= cfg_.locateHoldMs) {
    setIdle();
  }
  if (mode_ == LedMode::Startup && now - modeStart_ >= 2400) {
    setIdle();
  }
  render();
}

void LedEngine::playStartup() {
  mode_ = cfg_.startupAnim == StartupAnim::None ? LedMode::Idle : LedMode::Startup;
  modeStart_ = millis();
}

void LedEngine::setIdle() {
  mode_ = (cfg_.idleAnim == IdleAnim::Off) ? LedMode::Off : LedMode::Idle;
  modeStart_ = millis();
}

void LedEngine::off() {
  mode_ = LedMode::Off;
  modeStart_ = millis();
}

void LedEngine::locate(uint8_t row, uint8_t col) {
  locRow_ = row;
  locCol_ = col;
  mode_ = LedMode::Locate;
  modeStart_ = millis();
}

void LedEngine::flash(uint8_t row, uint8_t col, uint32_t color, uint16_t ms) {
  locRow_ = row;
  locCol_ = col;
  flashColor_ = color;
  flashMs_ = ms ? ms : 350;
  mode_ = LedMode::Flash;
  modeStart_ = millis();
}

void LedEngine::identifyLed(int index) {
  identifyIndex_ = index;
  mode_ = LedMode::Identify;
  modeStart_ = millis();
}

void LedEngine::showCorners() {
  mode_ = LedMode::Corners;
  modeStart_ = millis();
}

void LedEngine::startWalk(uint16_t dwellMs) {
  walkDwell_ = dwellMs < 80 ? 80 : dwellMs;
  walkPos_ = 0;
  mode_ = LedMode::Walk;
  modeStart_ = millis();
}

void LedEngine::stopWalk() {
  if (mode_ == LedMode::Walk) setIdle();
}

void LedEngine::setStock(const std::vector<CellLight>& stock) {
  stock_ = stock;
}

bool LedEngine::walkStep(uint8_t& row, uint8_t& col, int& led) {
  if (!rack_) return false;
  const int n = rack_->cellCount();
  if (n <= 0) return false;
  const uint16_t step = static_cast<uint16_t>(((millis() - modeStart_) / walkDwell_) % n);
  walkPos_ = step;
  row = static_cast<uint8_t>(step / rack_->cols());
  col = static_cast<uint8_t>(step % rack_->cols());
  led = rack_->ledFor(row, col);
  return true;
}

const CellLight* LedEngine::stockAt(uint8_t row, uint8_t col) const {
  for (const auto& s : stock_) {
    if (s.row == row && s.col == col) return &s;
  }
  return nullptr;
}

void LedEngine::cellColor(uint8_t row, uint8_t col, uint8_t& r, uint8_t& g, uint8_t& b) const {
  if (const CellLight* s = stockAt(row, col)) {
    unpack(s->color, r, g, b);
    return;
  }
  r = 18;
  g = 16;
  b = 14;
}

void LedEngine::setPixelRgb(int index, uint8_t r, uint8_t g, uint8_t b, uint8_t scale) {
  if (!strip_ || index < 0 || index >= static_cast<int>(strip_->numPixels())) return;
  if (scale < 255) {
    r = static_cast<uint8_t>((r * scale) / 255);
    g = static_cast<uint8_t>((g * scale) / 255);
    b = static_cast<uint8_t>((b * scale) / 255);
  }
  strip_->setPixelColor(index, strip_->Color(r, g, b));
}

void LedEngine::render() {
  if (!strip_ || !rack_) return;
  strip_->clear();

  const uint32_t now = millis();
  const float t = (now - modeStart_) / 1000.0f;
  const uint8_t hi = cfg_.brightness;
  const uint8_t lo = cfg_.idleBrightness;
  const int rows = rack_->rows();
  const int cols = rack_->cols();

  auto paintCell = [&](uint8_t row, uint8_t col, uint8_t r, uint8_t g, uint8_t b, uint8_t scale) {
    setPixelRgb(rack_->ledFor(row, col), r, g, b, scale);
  };

  if (mode_ == LedMode::Off) {
    strip_->show();
    return;
  }

  if (mode_ == LedMode::Identify) {
    setPixelRgb(identifyIndex_, 255, 255, 255, hi);
    strip_->show();
    return;
  }

  if (mode_ == LedMode::Corners) {
    paintCell(0, 0, 220, 40, 40, hi);
    if (cols > 1) paintCell(0, cols - 1, 40, 200, 70, hi);
    if (rows > 1) paintCell(rows - 1, 0, 40, 90, 230, hi);
    if (rows > 1 && cols > 1) paintCell(rows - 1, cols - 1, 240, 240, 240, hi);
    strip_->show();
    return;
  }

  if (mode_ == LedMode::Walk) {
    uint8_t wr = 0, wc = 0;
    int led = -1;
    walkStep(wr, wc, led);
    for (int r = 0; r < rows; r++) {
      for (int c = 0; c < cols; c++) {
        uint8_t cr, cg, cb;
        cellColor(r, c, cr, cg, cb);
        const bool on = (r == wr && c == wc);
        paintCell(r, c, on ? 255 : cr, on ? 255 : cg, on ? 255 : cb, on ? hi : lo / 3);
      }
    }
    strip_->show();
    return;
  }

  if (mode_ == LedMode::Startup) {
    const float dur = 2.2f;
    const float p = min(1.0f, t / dur);
    if (cfg_.startupAnim == StartupAnim::Lightning) {
      const int bolt = static_cast<int>(p * cfg_.ledCount);
      for (int i = 0; i < static_cast<int>(cfg_.ledCount); i++) {
        const int d = abs(i - bolt);
        const uint8_t s = d < 3 ? hi : (d < 8 ? hi / 4 : 0);
        const uint32_t hue = static_cast<uint32_t>((i * 65535ul) / max(1, (int)cfg_.ledCount));
        const uint32_t col = Adafruit_NeoPixel::gamma32(Adafruit_NeoPixel::ColorHSV(hue, 180, 255));
        uint8_t r, g, b;
        unpack(col, r, g, b);
        setPixelRgb(i, r, g, b, s);
      }
    } else if (cfg_.startupAnim == StartupAnim::Spiral) {
      const int n = rows * cols;
      const float head = p * (n + 6);
      for (int r = 0; r < rows; r++) {
        for (int c = 0; c < cols; c++) {
          const int si = spiralIndex(r, c, rows, cols);
          const float d = head - si;
          if (d < 0) continue;
          const float fade = d < 6 ? d / 6.0f : 1.0f;
          uint8_t cr, cg, cb;
          cellColor(r, c, cr, cg, cb);
          paintCell(r, c, lerp8(255, cr, fade), lerp8(170, cg, fade), lerp8(80, cb, fade), hi);
        }
      }
    } else {
      const float head = p * (cfg_.ledCount + 8);
      for (int i = 0; i < static_cast<int>(cfg_.ledCount); i++) {
        const float d = head - i;
        if (d < 0) continue;
        const float trail = max(0.0f, 1.0f - (d / 10.0f));
        uint8_t r = 230, g = 150, b = 70;
        uint8_t rr, rg, rb;
        uint8_t cellR, cellC;
        if (rack_->cellForLed(i, cellR, cellC)) cellColor(cellR, cellC, rr, rg, rb);
        else {
          rr = 20;
          rg = 16;
          rb = 12;
        }
        const float settle = min(1.0f, d / 14.0f);
        setPixelRgb(i, lerp8(r, rr, settle), lerp8(g, rg, settle), lerp8(b, rb, settle),
                    static_cast<uint8_t>(hi * max(trail, settle * 0.35f)));
      }
    }
    strip_->show();
    return;
  }

  if (mode_ == LedMode::Flash) {
    uint8_t fr, fg, fb;
    unpack(flashColor_, fr, fg, fb);
    const float pulse = 0.45f + 0.55f * fabsf(sinf(t * 18.0f));
    for (int r = 0; r < rows; r++) {
      for (int c = 0; c < cols; c++) {
        uint8_t cr, cg, cb;
        cellColor(r, c, cr, cg, cb);
        const bool on = (r == locRow_ && c == locCol_);
        paintCell(r, c, on ? fr : cr, on ? fg : cg, on ? fb : cb,
                  on ? static_cast<uint8_t>(hi * pulse) : lo / 4);
      }
    }
    strip_->show();
    return;
  }

  if (mode_ == LedMode::Locate) {
    const float pulse = 0.40f + 0.60f * (0.5f + 0.5f * sinf(t * 7.0f));
    uint8_t lr, lg, lb;
    unpack(cfg_.locateColor, lr, lg, lb);
    for (int r = 0; r < rows; r++) {
      for (int c = 0; c < cols; c++) {
        uint8_t cr, cg, cb;
        cellColor(r, c, cr, cg, cb);
        const bool on = (r == locRow_ && c == locCol_);
        if (on) {
          paintCell(r, c, lerp8(lr, 255, pulse * 0.35f), lerp8(lg, 255, pulse * 0.35f),
                    lerp8(lb, 255, pulse * 0.45f), static_cast<uint8_t>(hi * pulse));
        } else {
          paintCell(r, c, cr, cg, cb, lo / 5);
        }
      }
    }
    strip_->show();
    return;
  }

  // Idle
  if (cfg_.idleAnim == IdleAnim::Off) {
    strip_->show();
    return;
  }

  const uint8_t span = hi > lo ? static_cast<uint8_t>(hi - lo) : 1;

  for (int r = 0; r < rows; r++) {
    for (int c = 0; c < cols; c++) {
      const CellLight* s = stockAt(r, c);
      const bool filled = s && s->occupied;
      uint8_t cr, cg, cb;
      cellColor(r, c, cr, cg, cb);
      uint8_t scale = filled ? lo : 0;

      if (cfg_.idleAnim == IdleAnim::Breathe) {
        const float phase = t * 1.8f + (r * cols + c) * 0.37f;
        const float wave = 0.5f + 0.5f * sinf(phase);
        if (filled) {
          scale = static_cast<uint8_t>(lo + span * wave);
        } else {
          cr = 36;
          cg = 32;
          cb = 28;
          scale = static_cast<uint8_t>(max(8, lo / 2) * (0.35f + 0.65f * wave));
        }
      } else if (cfg_.idleAnim == IdleAnim::Sparkle) {
        const uint32_t seed = (now / 70) * 1664525u + static_cast<uint32_t>(r * 97 + c * 13 + 1) * 1013904223u;
        const uint8_t rnd = (seed >> 16) & 0xFF;
        const bool twinkle = rnd < (filled ? 28 : 18);
        if (filled) {
          scale = twinkle ? hi : lo;
        } else if (twinkle) {
          cr = 220;
          cg = 210;
          cb = 190;
          scale = static_cast<uint8_t>(lo + span / 2);
        } else {
          scale = 0;
        }
      } else if (cfg_.idleAnim == IdleAnim::Rainbow) {
        const uint16_t hue = static_cast<uint16_t>(now * 12 + (r * cols + c) * 1800);
        const uint32_t col = Adafruit_NeoPixel::gamma32(Adafruit_NeoPixel::ColorHSV(hue, 200, 255));
        unpack(col, cr, cg, cb);
        scale = filled ? lo + 20 : lo / 3;
      } else if (cfg_.idleAnim == IdleAnim::Heatmap && filled) {
        const float q = min(1.0f, s->qty / 50.0f);
        cr = lerp8(40, 255, q);
        cg = lerp8(90, 90, q);
        cb = lerp8(220, 40, 1.0f - q);
        scale = lo + static_cast<uint8_t>(q * 40);
      }

      paintCell(r, c, cr, cg, cb, scale);
    }
  }
  strip_->show();
}
