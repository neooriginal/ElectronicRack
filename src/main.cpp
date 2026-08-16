#include "App.h"

void setup() { app.begin(); }

void loop() {
  app.loop();
  // Yield a tick so the idle task can run; a tight loop() starves the FreeRTOS
  // idle task and eventually trips the task watchdog.
  delay(1);
}
