#include "display.h"

#include <U8g2lib.h>
#include <Wire.h>

#if __has_include("config.h")
#include "config.h"
#endif

// 1.3" SH1106 modullerde config.h'a  #define OLED_SH1106  ekle
#ifdef OLED_SH1106
static U8G2_SH1106_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE);
#else
static U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE);
#endif

#ifndef OLED_SLEEP_MS
#define OLED_SLEEP_MS (5UL * 60 * 1000)  // bos odada 5 dk sonra ekran kapanir (OLED yanmasin)
#endif

static const uint32_t FRAME_MS = 80;
static const float MAX_CM = 400.0f;
static const int SONAR_R = 30;
static const int HALF_FOV = 60;

static bool present = false;
static bool asleep = false;
static uint32_t lastFrame = 0;
static uint32_t lastSeen = 0;

void displayBegin(int sda, int scl) {
  Wire.begin(sda, scl);
  Wire.beginTransmission(0x3C);
  present = Wire.endTransmission() == 0;
  if (!present) {
    Serial.println("[oled] ekran bulunamadi (0x3C), atlaniyor");
    return;
  }
  oled.setBusClock(400000);
  oled.begin();
  oled.setContrast(160);
  Serial.println("[oled] hazir");
}

static void polar(int ox, int oy, float r, float deg, int& x, int& y) {
  float a = (deg - 90.0f) * DEG_TO_RAD;
  x = ox + (int)lroundf(r * cosf(a));
  y = oy + (int)lroundf(r * sinf(a));
}

static void arc(int ox, int oy, float r, int step = 4) {
  int px, py, x, y;
  polar(ox, oy, r, -HALF_FOV, px, py);
  for (int deg = -HALF_FOV + step; deg <= HALF_FOV; deg += step) {
    polar(ox, oy, r, deg, x, y);
    oled.drawLine(px, py, x, y);
    px = x;
    py = y;
  }
}

static void dottedArc(int ox, int oy, float r) {
  int x, y;
  for (int deg = -HALF_FOV; deg <= HALF_FOV; deg += 10) {
    polar(ox, oy, r, deg, x, y);
    oled.drawPixel(x, y);
  }
}

static void wifiBars(int x, int y, bool ok, int rssi) {
  int bars = !ok ? 0 : rssi > -55 ? 4 : rssi > -65 ? 3 : rssi > -75 ? 2 : 1;
  for (int i = 0; i < 4; i++) {
    int h = 2 + i * 2;
    if (i < bars)
      oled.drawBox(x + i * 3, y - h, 2, h);
    else
      oled.drawPixel(x + i * 3, y - 1);
  }
}

void displayUpdate(const DisplayData& d) {
  if (!present) return;
  uint32_t now = millis();
  if (now - lastFrame < FRAME_MS) return;
  lastFrame = now;

  if (d.presence || !d.radarOk || d.waking || lastSeen == 0) lastSeen = now;
  bool shouldSleep = now - lastSeen > OLED_SLEEP_MS;
  if (shouldSleep != asleep) {
    asleep = shouldSleep;
    oled.setPowerSave(asleep);
  }
  if (asleep) return;

  // Ayni piksellerin surekli yanmasini azaltmak icin dakikada bir 1 px kaydir
  int shift = (now / 60000) % 3 - 1;

  oled.clearBuffer();

  // --- ust bar ---
  oled.setFont(u8g2_font_5x7_tr);
  oled.drawStr(0 + shift, 7, "RADARWAKE");
  const char* pcLabel = d.waking ? "PC WAKE" : strcmp(d.pc, "on") == 0 ? "PC ON" : strcmp(d.pc, "waking") == 0 ? "PC BOOT" : strcmp(d.pc, "off") == 0 ? "PC OFF" : "PC ?";
  int w = oled.getStrWidth(pcLabel);
  oled.drawStr(112 - w + shift, 7, pcLabel);
  wifiBars(116 + shift, 8, d.wifiOk, d.rssi);
  oled.drawHLine(0, 10, 128);

  // --- mini sonar (sol) ---
  int ox = 33 + shift, oy = 62;
  int lx, ly, rx, ry;
  polar(ox, oy, SONAR_R, -HALF_FOV, lx, ly);
  polar(ox, oy, SONAR_R, HALF_FOV, rx, ry);
  oled.drawLine(ox, oy, lx, ly);
  oled.drawLine(ox, oy, rx, ry);
  arc(ox, oy, SONAR_R, 6);
  dottedArc(ox, oy, SONAR_R / 2.0f);

  if (d.radarOk) {
    // Tarama cizgisi: -60..+60 arasi gidip gelir
    float t = (now % 2400) / 2400.0f;
    float sweep = -HALF_FOV + (t < 0.5f ? t * 2 : (1 - t) * 2) * 2 * HALF_FOV;
    int sx, sy;
    polar(ox, oy, SONAR_R, sweep, sx, sy);
    oled.drawLine(ox, oy, sx, sy);
  }

  if (d.presence && d.distCm > 0) {
    float r = min((float)d.distCm, MAX_CM) / MAX_CM * SONAR_R;
    // Hareketli hedef yanip soner, sabit hedef kalin cizilir
    if (!d.moving || (now / 250) % 2 == 0) {
      arc(ox, oy, r);
      if (!d.moving) arc(ox, oy, r + 1);
    }
  }
  oled.drawDisc(ox, oy, 2);

  // --- okumalar (sag) ---
  int tx = 70 + shift;
  if (!d.wifiOk) {
    oled.setFont(u8g2_font_6x10_tr);
    oled.drawStr(tx, 30, "NO WIFI");
  } else if (!d.radarOk) {
    oled.setFont(u8g2_font_6x10_tr);
    oled.drawStr(tx, 30, "NO RADAR");
    oled.setFont(u8g2_font_5x7_tr);
    oled.drawStr(tx, 42, "check wiring");
  } else if (d.presence && d.distCm > 0) {
    char buf[8];
    snprintf(buf, sizeof(buf), "%.2f", d.distCm / 100.0f);
    oled.setFont(u8g2_font_logisoso16_tn);
    int numW = oled.drawStr(tx, 34, buf);
    oled.setFont(u8g2_font_5x7_tr);
    oled.drawStr(tx + numW + 2, 34, "m");
    oled.drawStr(tx, 46, d.moving ? "MOVING" : "STILL");
    // sinyal gucu cubugu
    oled.drawFrame(tx, 52, 54, 5);
    oled.drawBox(tx + 1, 53, (52 * d.energy) / 100, 3);
  } else {
    oled.setFont(u8g2_font_6x10_tr);
    oled.drawStr(tx, 30, "CLEAR");
    oled.setFont(u8g2_font_5x7_tr);
    oled.drawStr(tx, 42, "no contact");
  }

  if (d.waking) {
    oled.setFont(u8g2_font_5x7_tr);
    oled.drawStr(tx, 62, ">> WAKE SENT");
  }

  oled.sendBuffer();
}
