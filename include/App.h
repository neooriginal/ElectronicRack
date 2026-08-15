#pragma once

#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include "CatalogProxy.h"
#include "HttpApp.h"
#include "Inventory.h"
#include "LedEngine.h"
#include "OtaUpdate.h"
#include "Rack.h"
#include "Store.h"
#include "Types.h"
#include "WifiStation.h"

class App {
public:
  Store store;
  RackModel rack;
  Inventory inventory;
  LedEngine leds;
  WifiStation wifi;
  CatalogProxy catalog;
  HttpApp http;
  OtaUpdate ota;
  AppConfig config;

  void begin();
  void loop();

  void lock();
  void unlock();

  bool saveConfig();
  bool saveInventory();
  void markInventoryDirty();
  void flushInventory();
  void applyConfig(bool rebuildLeds);
  void refreshStockLights();
  bool mergeConfig(JsonVariantConst src, bool& rebuildLeds);

private:
  SemaphoreHandle_t mux_ = nullptr;
  bool inventoryDirty_ = false;
  uint32_t inventoryDirtyAt_ = 0;
};

extern App app;
