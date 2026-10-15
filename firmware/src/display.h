// 0.96" SSD1306 128x64 I2C OLED. Ne gosterilecegini sunucudaki ekran profili belirler
// (status / sonar / clock / gif / gif_status / gif_corner); ESP tek bir "bundle" tutar.
#pragma once
#include <Arduino.h>

struct DisplayData {
  bool wifiOk;
  int rssi;
  bool radarOk;
  bool presence;
  bool moving;
  uint16_t distCm;  // ham hedef mesafesi, 0 = hedef yok (ekran kendisi yumusatir)
  const char* pc;   // "on" | "off" | "waking" | "?"
  bool waking;      // guc tusu darbesi yeni gonderildi
};

void displayBegin(int sda, int scl);
// Cagri sikligi serbest; ekran kendi hizinda cizer.
void displayUpdate(const DisplayData& d);

// Sunucudan indirilen bundle: u16 json_len | JSON | 1 bit kareler.
// Basarili olursa buf'in sahipligini alir (eski bundle'i serbest birakir) ve true doner.
bool displaySetBundle(uint8_t* buf, size_t len);
