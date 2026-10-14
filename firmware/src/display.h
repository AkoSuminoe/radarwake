// 0.96" SSD1306 128x64 I2C OLED: mini sonar + mesafe/hareket/PC durumu.
#pragma once
#include <Arduino.h>

struct DisplayData {
  bool wifiOk;
  int rssi;
  bool radarOk;
  bool presence;
  bool moving;
  uint16_t distCm;  // 0 = hedef yok
  uint8_t energy;   // 0-100
  const char* pc;   // "on" | "off" | "waking" | "?"
  bool waking;      // guc tusu darbesi yeni gonderildi
};

void displayBegin(int sda, int scl);
// Cagri sikligi serbest; ekran kendi hizinda (~12 fps) cizer.
void displayUpdate(const DisplayData& d);
