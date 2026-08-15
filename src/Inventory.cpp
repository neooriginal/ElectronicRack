#include "Inventory.h"

#include <algorithm>

#include "Types.h"

static StockLoc* locAt(Item& item, uint8_t row, uint8_t col) {
  for (auto& loc : item.locs) {
    if (loc.row == row && loc.col == col) return &loc;
  }
  return nullptr;
}

static void itemToJson(JsonObject o, const Item& item) {
  o["id"] = item.id;
  o["name"] = item.name;
  o["mpn"] = item.mpn;
  o["sku"] = item.sku;
  o["category"] = item.category;
  o["package"] = item.pkg;
  o["brand"] = item.brand;
  o["notes"] = item.notes;
  o["source"] = item.source;
  o["color"] = hexColor(item.color);
  JsonArray locs = o["locs"].to<JsonArray>();
  for (const auto& loc : item.locs) {
    JsonObject l = locs.add<JsonObject>();
    l["row"] = loc.row;
    l["col"] = loc.col;
    l["cell"] = cellLabel(loc.row, loc.col);
    l["qty"] = loc.qty;
  }
  int32_t total = 0;
  for (const auto& loc : item.locs) total += loc.qty;
  o["qty"] = total;
}

static void itemFromJson(Item& item, JsonVariantConst v) {
  item.id = v["id"] | newItemId();
  item.name = v["name"] | "";
  item.mpn = v["mpn"] | "";
  item.sku = v["sku"] | "";
  item.category = v["category"] | "other";
  item.pkg = v["package"] | v["pkg"] | "";
  item.brand = v["brand"] | "";
  item.notes = v["notes"] | "";
  item.source = v["source"] | "";
  if (v["color"].is<const char*>()) {
    item.color = parseHexColor(v["color"].as<const char*>(), categoryColor(item.category));
  } else {
    item.color = categoryColor(item.category);
  }
  item.locs.clear();
  JsonArrayConst locs = v["locs"].as<JsonArrayConst>();
  if (!locs.isNull()) {
    for (JsonVariantConst l : locs) {
      StockLoc loc;
      loc.row = l["row"] | 0;
      loc.col = l["col"] | 0;
      loc.qty = l["qty"] | 0;
      if (loc.qty != 0) item.locs.push_back(loc);
    }
  } else if (v["cell"].is<const char*>()) {
    uint8_t r = 0, c = 0;
    if (parseCellLabel(v["cell"].as<const char*>(), MAX_ROWS, MAX_COLS, r, c)) {
      StockLoc loc;
      loc.row = r;
      loc.col = c;
      loc.qty = v["qty"] | 0;
      if (loc.qty != 0) item.locs.push_back(loc);
    }
  }
}

bool Inventory::load(Store& store) {
  items_.clear();
  JsonDocument doc;
  if (!store.readJson("/inventory.json", doc)) return false;
  return fromJson(doc);
}

bool Inventory::save(Store& store) const {
  JsonDocument doc;
  toJson(doc);
  return store.writeJson("/inventory.json", doc);
}

Item* Inventory::findById(const String& id) {
  for (auto& item : items_) {
    if (item.id == id) return &item;
  }
  return nullptr;
}

const Item* Inventory::findById(const String& id) const {
  for (const auto& item : items_) {
    if (item.id == id) return &item;
  }
  return nullptr;
}

Item* Inventory::findByCell(uint8_t row, uint8_t col) {
  for (auto& item : items_) {
    if (locAt(item, row, col)) return &item;
  }
  return nullptr;
}

const Item* Inventory::findByCell(uint8_t row, uint8_t col) const {
  for (const auto& item : items_) {
    for (const auto& loc : item.locs) {
      if (loc.row == row && loc.col == col) return &item;
    }
  }
  return nullptr;
}

void Inventory::prune(Item& item) {
  item.locs.erase(std::remove_if(item.locs.begin(), item.locs.end(),
                                 [](const StockLoc& l) { return l.qty == 0; }),
                  item.locs.end());
}

Item* Inventory::place(const Item& proto, uint8_t row, uint8_t col, int32_t qty) {
  if (qty < 0) qty = 0;

  Item* occupant = findByCell(row, col);
  if (occupant) {
    const bool same =
        (proto.id.length() && occupant->id == proto.id) ||
        (proto.mpn.length() && proto.mpn == occupant->mpn && proto.name == occupant->name) ||
        (proto.name.length() && proto.name == occupant->name && proto.pkg == occupant->pkg);
    if (!same) {
      clearCell(row, col);
      occupant = nullptr;
    }
  }

  Item* item = occupant;
  if (!item && proto.id.length()) item = findById(proto.id);
  if (!item && proto.mpn.length()) {
    for (auto& it : items_) {
      if (it.mpn == proto.mpn && it.name == proto.name) {
        item = &it;
        break;
      }
    }
  }
  if (!item) {
    if (items_.size() >= MAX_ITEMS) return nullptr;
    Item fresh = proto;
    if (!fresh.id.length()) fresh.id = newItemId();
    if (!fresh.color) fresh.color = categoryColor(fresh.category);
    items_.push_back(fresh);
    item = &items_.back();
  } else {
    if (proto.name.length()) item->name = proto.name;
    if (proto.mpn.length()) item->mpn = proto.mpn;
    if (proto.sku.length()) item->sku = proto.sku;
    if (proto.category.length()) item->category = proto.category;
    if (proto.pkg.length()) item->pkg = proto.pkg;
    if (proto.brand.length()) item->brand = proto.brand;
    if (proto.notes.length()) item->notes = proto.notes;
    if (proto.source.length()) item->source = proto.source;
    if (proto.color) item->color = proto.color;
  }

  if (auto* loc = locAt(*item, row, col)) {
    loc->qty = qty;
  } else if (item->locs.size() < MAX_LOCS_PER_ITEM) {
    StockLoc loc;
    loc.row = row;
    loc.col = col;
    loc.qty = qty;
    item->locs.push_back(loc);
  }
  prune(*item);
  if (item->locs.empty()) {
    removeId(item->id);
    return nullptr;
  }
  return item;
}

bool Inventory::adjust(uint8_t row, uint8_t col, int32_t delta, int32_t& newQty) {
  Item* item = findByCell(row, col);
  if (!item) return false;
  StockLoc* loc = locAt(*item, row, col);
  if (!loc) return false;
  int32_t q = loc->qty + delta;
  if (q < 0) q = 0;
  loc->qty = q;
  newQty = q;
  prune(*item);
  if (item->locs.empty()) removeId(item->id);
  return true;
}

bool Inventory::setQty(uint8_t row, uint8_t col, int32_t qty, int32_t& newQty) {
  if (qty < 0) qty = 0;
  Item* item = findByCell(row, col);
  if (!item) return false;
  StockLoc* loc = locAt(*item, row, col);
  if (!loc) return false;
  loc->qty = qty;
  newQty = qty;
  prune(*item);
  if (item->locs.empty()) removeId(item->id);
  return true;
}

bool Inventory::clearCell(uint8_t row, uint8_t col) {
  Item* item = findByCell(row, col);
  if (!item) return false;
  item->locs.erase(std::remove_if(item->locs.begin(), item->locs.end(),
                                  [&](const StockLoc& l) { return l.row == row && l.col == col; }),
                   item->locs.end());
  if (item->locs.empty()) removeId(item->id);
  return true;
}

bool Inventory::move(uint8_t fromRow, uint8_t fromCol, uint8_t toRow, uint8_t toCol) {
  if (fromRow == toRow && fromCol == toCol) return true;
  Item* item = findByCell(fromRow, fromCol);
  if (!item) return false;
  StockLoc* from = locAt(*item, fromRow, fromCol);
  if (!from) return false;
  const int32_t qty = from->qty;
  Item copy = *item;
  clearCell(fromRow, fromCol);
  place(copy, toRow, toCol, qty);
  return true;
}

bool Inventory::removeId(const String& id) {
  const auto before = items_.size();
  items_.erase(std::remove_if(items_.begin(), items_.end(),
                              [&](const Item& i) { return i.id == id; }),
               items_.end());
  return items_.size() != before;
}

void Inventory::toJson(JsonDocument& doc) const {
  doc.clear();
  doc["version"] = 1;
  JsonArray arr = doc["items"].to<JsonArray>();
  for (const auto& item : items_) {
    itemToJson(arr.add<JsonObject>(), item);
  }
}

bool Inventory::fromJson(JsonVariantConst src) {
  items_.clear();
  JsonArrayConst arr = src["items"].as<JsonArrayConst>();
  if (arr.isNull()) return true;
  for (JsonVariantConst v : arr) {
    if (items_.size() >= MAX_ITEMS) break;
    Item item;
    itemFromJson(item, v);
    if (item.name.length()) items_.push_back(item);
  }
  return true;
}

void Inventory::snapshot(std::vector<CellLight>& out) const {
  out.clear();
  for (const auto& item : items_) {
    for (const auto& loc : item.locs) {
      CellLight cl;
      cl.row = loc.row;
      cl.col = loc.col;
      cl.color = item.color ? item.color : categoryColor(item.category);
      cl.qty = loc.qty;
      cl.occupied = loc.qty > 0;
      out.push_back(cl);
    }
  }
}
