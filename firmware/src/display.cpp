#include "display.h"

#include <ArduinoJson.h>
#include <U8g2lib.h>
#include <Wire.h>
#include <time.h>

#if __has_include("config.h")
#include "config.h"
#endif

// 1.3" SH1106 modullerde config.h'a  #define OLED_SH1106  ekle
#ifdef OLED_SH1106
static U8G2_SH1106_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE);
#else
static U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE);
#endif

static const float MAX_CM = 400.0f;
static const int HALF_FOV = 60;
static const uint16_t MAX_FRAMES = 120;

// --- aktif bundle ---
struct Bundle {
  char layout[12] = "status";
  uint8_t contrast = 160;
  bool flip = false;
  uint8_t sweep = 0;
  char corner[3] = "br";
  bool showPc = true;
  uint16_t sleepMin = 5;
  char tz[64] = "";
  // GIF
  uint16_t w = 0, h = 0, x = 0, y = 0, n = 0;
  uint16_t dur[MAX_FRAMES];
  const uint8_t* frames = nullptr;
  uint8_t* raw = nullptr;  // indirilen tampon (frames bunun icini gosterir)
};
static Bundle bundle;

static bool present = false;
static bool asleep = false;
static uint32_t lastFrame = 0;
static uint32_t lastSeen = 0;
static uint16_t gifFrame = 0;
static uint32_t gifFrameAt = 0;

// --- sakin okumalar: yumusatma + histerezis ---
static float emaCm = 0;
static uint16_t shownCm = 0;  // ekranda gorunen deger (0.1 m adimli)
static uint32_t shownAt = 0;
static uint32_t emaAt = 0;
static bool shownPresent = false;
static uint32_t absentSince = 0;
static bool shownMoving = false;
static uint32_t movingSince = 0;
static bool lastRawMoving = false;

static void smooth(const DisplayData& d, uint32_t now) {
  // Varlik: hemen "var", 3 sn sonra "yok"
  if (d.presence) {
    shownPresent = true;
    absentSince = 0;
  } else if (shownPresent) {
    if (!absentSince) absentSince = now;
    if (now - absentSince > 3000) shownPresent = false;
  }

  // Mesafe: 10 Hz'de EMA (alfa 0.25)
  if (now - emaAt >= 100) {
    emaAt = now;
    if (d.presence && d.distCm > 0) emaCm = emaCm <= 0 ? d.distCm : emaCm + 0.25f * (d.distCm - emaCm);
    if (!shownPresent) emaCm = 0;
  }
  // Gorunen deger sadece 8 cm'den fazla farkta ve en fazla saniyede bir degisir
  if (emaCm <= 0) {
    shownCm = 0;
  } else if (shownCm == 0 || (fabsf(emaCm - shownCm) >= 8 && now - shownAt >= 1000)) {
    shownCm = (uint16_t)(lroundf(emaCm / 10.0f) * 10);
    shownAt = now;
  }

  // MOVING/STILL: yeni durum 2 sn surerse degisir
  if (d.moving != lastRawMoving) {
    lastRawMoving = d.moving;
    movingSince = now;
  }
  if (d.moving != shownMoving && now - movingSince >= 2000) shownMoving = d.moving;
}

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
  oled.setContrast(bundle.contrast);
  Serial.println("[oled] hazir");
}

bool displaySetBundle(uint8_t* buf, size_t len) {
  if (len < 2) return false;
  size_t jlen = buf[0] | (buf[1] << 8);
  if (2 + jlen > len) return false;
  JsonDocument doc;
  if (deserializeJson(doc, (const char*)buf + 2, jlen)) return false;

  Bundle nb;
  strlcpy(nb.layout, doc["layout"] | "status", sizeof(nb.layout));
  nb.contrast = doc["contrast"] | 160;
  nb.flip = doc["flip"] | false;
  nb.sweep = doc["sweep"] | 0;
  strlcpy(nb.corner, doc["corner"] | "br", sizeof(nb.corner));
  nb.showPc = doc["show_pc"] | true;
  nb.sleepMin = doc["sleep_min"] | 5;
  strlcpy(nb.tz, doc["tz"] | "", sizeof(nb.tz));

  JsonObject anim = doc["anim"];
  if (!anim.isNull()) {
    nb.w = anim["w"] | 0;
    nb.h = anim["h"] | 0;
    nb.x = anim["x"] | 0;
    nb.y = anim["y"] | 0;
    nb.n = min<uint16_t>(anim["n"] | 0, MAX_FRAMES);
    size_t frameBytes = (size_t)((nb.w + 7) / 8) * nb.h;
    if (nb.w == 0 || nb.w > 128 || nb.h == 0 || nb.h > 64 || 2 + jlen + frameBytes * nb.n > len) return false;
    JsonArray dur = anim["dur"];
    for (uint16_t i = 0; i < nb.n; i++) nb.dur[i] = max<uint16_t>(dur[i] | 100, 40);
    nb.frames = buf + 2 + jlen;
  }
  nb.raw = buf;

  bool tzChanged = strcmp(nb.tz, bundle.tz) != 0;
  free(bundle.raw);
  bundle = nb;
  gifFrame = 0;
  gifFrameAt = millis();
  lastSeen = millis();  // yeni profil gelince ekran uyansin

  if (tzChanged && bundle.tz[0]) configTzTime(bundle.tz, "pool.ntp.org", "time.google.com");
  if (present) {
    oled.setContrast(bundle.contrast);
    oled.setFlipMode(bundle.flip);
  }
  Serial.printf("[disp] profil=%s duzen=%s kare=%u\n", (const char*)(doc["name"] | "?"), bundle.layout, bundle.n);
  return true;
}

// --- cizim yardimcilari ---

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

static const char* pcLabel(const DisplayData& d) {
  if (d.waking) return "WAKE";
  if (strcmp(d.pc, "on") == 0) return "PC ON";
  if (strcmp(d.pc, "waking") == 0) return "BOOT";
  if (strcmp(d.pc, "off") == 0) return "PC OFF";
  return "PC ?";
}

static void distText(char* buf, size_t n) {
  snprintf(buf, n, "%.1f", shownCm / 100.0f);
}

// Mesafe yoksa / hata varsa kisa durum yazisi, yoksa nullptr
static const char* problem(const DisplayData& d) {
  if (!d.wifiOk) return "NO WIFI";
  if (!d.radarOk) return "NO RADAR";
  return nullptr;
}

static void topBar(const DisplayData& d, int sx) {
  oled.setFont(u8g2_font_5x7_tr);
  oled.drawStr(sx, 7, shownPresent ? "PRESENT" : "CLEAR");
  if (bundle.showPc) {
    const char* pc = pcLabel(d);
    oled.drawStr(112 - oled.getStrWidth(pc) + sx, 7, pc);
  }
  wifiBars(116 + sx, 8, d.wifiOk, d.rssi);
}

// --- duzenler ---

static void drawStatus(const DisplayData& d, int sx) {
  topBar(d, sx);
  oled.drawHLine(0, 11, 128);
  const char* p = problem(d);
  if (p) {
    oled.setFont(u8g2_font_6x10_tr);
    oled.drawStr((128 - oled.getStrWidth(p)) / 2 + sx, 40, p);
    return;
  }
  if (shownCm > 0) {
    char buf[8];
    distText(buf, sizeof(buf));
    oled.setFont(u8g2_font_logisoso28_tn);
    int w = oled.getStrWidth(buf);
    int x = (128 - w - 10) / 2 + sx;
    oled.drawStr(x, 50, buf);
    oled.setFont(u8g2_font_6x10_tr);
    oled.drawStr(x + w + 3, 50, "m");
    oled.setFont(u8g2_font_5x7_tr);
    const char* m = shownMoving ? "moving" : "still";
    oled.drawStr((128 - oled.getStrWidth(m)) / 2 + sx, 62, m);
  } else {
    oled.setFont(u8g2_font_6x10_tr);
    const char* t = "no one in range";
    oled.drawStr((128 - oled.getStrWidth(t)) / 2 + sx, 41, t);
  }
}

static void drawSonar(const DisplayData& d, uint32_t now, int sx) {
  topBar(d, sx);
  int ox = 34 + sx, oy = 63;
  const int R = 44;
  int lx, ly, rx, ry;
  polar(ox, oy, R, -HALF_FOV, lx, ly);
  polar(ox, oy, R, HALF_FOV, rx, ry);
  oled.drawLine(ox, oy, lx, ly);
  oled.drawLine(ox, oy, rx, ry);
  arc(ox, oy, R, 6);
  dottedArc(ox, oy, R / 2.0f);

  if (bundle.sweep && d.radarOk) {
    static const uint32_t PERIOD[] = {0, 9000, 5000, 2800};
    uint32_t period = PERIOD[min<uint8_t>(bundle.sweep, 3)];
    float t = (now % period) / (float)period;
    float sweep = -HALF_FOV + (t < 0.5f ? t * 2 : (1 - t) * 2) * 2 * HALF_FOV;
    int x, y;
    polar(ox, oy, R, sweep, x, y);
    oled.drawLine(ox, oy, x, y);
  }
  if (shownCm > 0) {
    float r = min((float)shownCm, MAX_CM) / MAX_CM * R;
    arc(ox, oy, r);
    arc(ox, oy, r + 1);
  }
  oled.drawDisc(ox, oy, 2);

  int tx = 84 + sx;
  const char* p = problem(d);
  if (p) {
    oled.setFont(u8g2_font_5x7_tr);
    oled.drawStr(tx, 36, p);
  } else if (shownCm > 0) {
    char buf[8];
    distText(buf, sizeof(buf));
    oled.setFont(u8g2_font_logisoso20_tn);
    int w = oled.drawStr(tx, 42, buf);
    oled.setFont(u8g2_font_5x7_tr);
    oled.drawStr(tx + w + 2, 42, "m");
    oled.drawStr(tx, 54, shownMoving ? "moving" : "still");
  } else {
    oled.setFont(u8g2_font_5x7_tr);
    oled.drawStr(tx, 38, "clear");
  }
}

static void drawClock(const DisplayData& d, int sx) {
  struct tm t;
  bool synced = getLocalTime(&t, 0) && t.tm_year > 120;
  char hm[6] = "--:--";
  char date[16] = "";
  if (synced) {
    strftime(hm, sizeof(hm), "%H:%M", &t);
    strftime(date, sizeof(date), "%a %d %b", &t);
  }
  oled.setFont(u8g2_font_logisoso32_tn);
  oled.drawStr((128 - oled.getStrWidth(hm)) / 2 + sx, 44, hm);
  oled.setFont(u8g2_font_6x10_tr);
  oled.drawStr((128 - oled.getStrWidth(date)) / 2 + sx, 60, date);
  if (shownPresent)
    oled.drawDisc(122 + sx, 4, 2);
  else
    oled.drawCircle(122 + sx, 4, 2);
}

static void drawGif(uint32_t now) {
  if (!bundle.frames || !bundle.n) {
    oled.setFont(u8g2_font_6x10_tr);
    oled.drawStr(43, 30, "NO GIF");
    oled.setFont(u8g2_font_5x7_tr);
    oled.drawStr(9, 44, "pick one in the dashboard");
    return;
  }
  if (now - gifFrameAt >= bundle.dur[gifFrame]) {
    gifFrameAt = now;
    gifFrame = (gifFrame + 1) % bundle.n;
  }
  size_t frameBytes = (size_t)((bundle.w + 7) / 8) * bundle.h;
  oled.drawXBM(bundle.x, bundle.y, bundle.w, bundle.h, bundle.frames + frameBytes * gifFrame);
}

static void drawGifStatus(const DisplayData& d, uint32_t now) {
  drawGif(now);
  if (!bundle.frames) return;
  int tx = 70;
  oled.setFont(u8g2_font_5x7_tr);
  if (bundle.showPc) oled.drawStr(tx, 8, pcLabel(d));
  const char* p = problem(d);
  if (p) {
    oled.drawStr(tx, 36, p);
  } else if (shownCm > 0) {
    char buf[8];
    distText(buf, sizeof(buf));
    oled.setFont(u8g2_font_logisoso20_tn);
    int w = oled.drawStr(tx, 42, buf);
    oled.setFont(u8g2_font_5x7_tr);
    oled.drawStr(tx + w + 2, 42, "m");
    oled.drawStr(tx, 56, shownMoving ? "moving" : "still");
  } else {
    oled.drawStr(tx, 36, "clear");
  }
}

static void drawGifCorner(const DisplayData& d, uint32_t now) {
  drawGif(now);
  if (!bundle.frames) return;
  char buf[12];
  if (problem(d))
    strlcpy(buf, problem(d), sizeof(buf));
  else if (shownCm > 0)
    snprintf(buf, sizeof(buf), "%.1fm", shownCm / 100.0f);
  else
    strlcpy(buf, "--", sizeof(buf));
  oled.setFont(u8g2_font_6x10_tr);
  int w = oled.getStrWidth(buf) + 4, h = 11;
  int x = bundle.corner[1] == 'l' ? 0 : 128 - w;
  int y = bundle.corner[0] == 't' ? 0 : 64 - h;
  oled.setDrawColor(0);
  oled.drawBox(x, y, w, h);
  oled.setDrawColor(1);
  oled.drawFrame(x, y, w, h);
  oled.drawStr(x + 2, y + 9, buf);
}

void displayUpdate(const DisplayData& d) {
  if (!present) return;
  uint32_t now = millis();
  smooth(d, now);

  bool gif = strncmp(bundle.layout, "gif", 3) == 0;
  // Statik duzenler 5 fps yeter; GIF sadece kare degisince (ya da 200 ms'de bir) cizilir
  bool gifDue = gif && bundle.n && now - gifFrameAt >= bundle.dur[gifFrame];
  uint32_t frameMs = strcmp(bundle.layout, "sonar") == 0 && bundle.sweep ? 60 : 200;
  if (!gifDue && now - lastFrame < frameMs) return;
  lastFrame = now;

  if (d.presence || d.waking || lastSeen == 0) lastSeen = now;
  bool shouldSleep = bundle.sleepMin && now - lastSeen > bundle.sleepMin * 60000UL;
  if (shouldSleep != asleep) {
    asleep = shouldSleep;
    oled.setPowerSave(asleep);
  }
  if (asleep) return;

  // Statik duzenlerde ayni piksellerin surekli yanmasini azaltmak icin dakikada 1 px kaydir
  int sx = gif ? 0 : (int)((now / 60000) % 3) - 1;

  oled.clearBuffer();
  if (strcmp(bundle.layout, "sonar") == 0)
    drawSonar(d, now, sx);
  else if (strcmp(bundle.layout, "clock") == 0)
    drawClock(d, sx);
  else if (strcmp(bundle.layout, "gif") == 0)
    drawGif(now);
  else if (strcmp(bundle.layout, "gif_status") == 0)
    drawGifStatus(d, now);
  else if (strcmp(bundle.layout, "gif_corner") == 0)
    drawGifCorner(d, now);
  else
    drawStatus(d, sx);
  oled.sendBuffer();
}
