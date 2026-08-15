#pragma once

#include <ArduinoJson.h>

#include "Store.h"
#include "Types.h"

class Inventory {
public:
  bool load(Store& store);
  bool save(Store& store) const;

  const std::vector<Item>& items() const { return items_; }
  Item* findById(const String& id);
  const Item* findById(const String& id) const;
  Item* findByCell(uint8_t row, uint8_t col);
  const Item* findByCell(uint8_t row, uint8_t col) const;

  // Place or merge a part into a cell. Replaces a different part in that cell.
  Item* place(const Item& proto, uint8_t row, uint8_t col, int32_t qty);
  bool adjust(uint8_t row, uint8_t col, int32_t delta, int32_t& newQty);
  bool setQty(uint8_t row, uint8_t col, int32_t qty, int32_t& newQty);
  bool clearCell(uint8_t row, uint8_t col);
  bool move(uint8_t fromRow, uint8_t fromCol, uint8_t toRow, uint8_t toCol);
  bool removeId(const String& id);

  void toJson(JsonDocument& doc) const;
  bool fromJson(JsonVariantConst src);
  void clear() { items_.clear(); }
  void snapshot(std::vector<CellLight>& out) const;

private:
  void prune(Item& item);
  std::vector<Item> items_;
};
