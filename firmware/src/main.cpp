// radarwake firmware: LD2410C varlik verisini backend'e raporlar,
// backend'den gelen "press_power" komutuyla PC guc tusuna optokuplor uzerinden basar.
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <ld2410.h>
#include <esp_task_wdt.h>

#include "display.h"

#if __has_include("config.h")
#include "config.h"
#else
#error "firmware/src/config.h yok: config.example.h dosyasini config.h olarak kopyala ve doldur"
#endif

static const uint32_t WDT_TIMEOUT_S = 30;

#ifndef OLED_SDA_PIN
#define OLED_SDA_PIN 8
#endif
#ifndef OLED_SCL_PIN
#define OLED_SCL_PIN 9
#endif

#ifndef LIVE_REPORT_INTERVAL_MS
#define LIVE_REPORT_INTERVAL_MS 1000
#endif

ld2410 radar;
Preferences prefs;

struct Reading {
  bool presence = false;
  bool moving = false;
  bool stationary = false;
  uint16_t movingDist = 0;
  uint16_t stationaryDist = 0;
  uint8_t movingEnergy = 0;
  uint8_t stationaryEnergy = 0;
};

Reading current;
bool lastSentPresence = false;
uint32_t lastReportAt = 0;
bool forceReport = true;

// Son calistirilan komut id'si NVS'te saklanir: ESP yeniden baslasa bile
// ayni komutu ikinci kez calistirip acilan PC'yi kapatmamak icin.
uint32_t lastExecutedCmd = 0;
uint32_t pendingAck = 0;

char pcState[8] = "?";  // backend cevabindan: on | off | waking

// Ekran profili: rapor cevabindaki "disp" surumu degisince bundle indirilir
char wantDisp[32] = "";
char haveDisp[32] = "";
uint32_t dispRetryAt = 0;

uint32_t pulseEndAt = 0;
uint32_t ledOffAt = 0;

void setLed(uint8_t r, uint8_t g, uint8_t b) { neopixelWrite(RGB_LED_PIN, r, g, b); }

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("[wifi] %s baglaniyor...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    esp_task_wdt_reset();
    delay(250);
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] baglandi, ip=%s rssi=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    // status: 1=SSID bulunamadi (2.4 GHz yok/uzak), 4=baglanti basarisiz (sifre?), 6=kopuk
    Serial.printf("[wifi] baglanamadi (status=%d), sonra tekrar denenecek\n", WiFi.status());
    WiFi.disconnect();
    int n = WiFi.scanNetworks();
    Serial.printf("[wifi] tarama: %d ag bulundu\n", n);
    for (int i = 0; i < n; i++) {
      if (WiFi.SSID(i) == WIFI_SSID)  // enc: 3=WPA2, 6=WPA3, 7=WPA2/WPA3
        Serial.printf("[wifi]   %s ch=%d rssi=%d enc=%d\n", WiFi.SSID(i).c_str(), WiFi.channel(i),
                      WiFi.RSSI(i), WiFi.encryptionType(i));
      esp_task_wdt_reset();
    }
    WiFi.scanDelete();
  }
}

// Radar surekli veri yollar (~10 Hz). Pin yonunu ve baud hizini tarar: TX/RX ters
// takildiysa ya da radar fabrika disi bir hiza ayarliysa da baglanir.
// Gecerli cerceve basliklari: veri F4 F3 F2 F1, komut cevabi FD FC FB FA.
static bool hasFrameHeader(const uint8_t* buf, int n) {
  for (int i = 0; i + 3 < n; i++) {
    if ((buf[i] == 0xF4 && buf[i + 1] == 0xF3 && buf[i + 2] == 0xF2 && buf[i + 3] == 0xF1) ||
        (buf[i] == 0xFD && buf[i + 1] == 0xFC && buf[i + 2] == 0xFB && buf[i + 3] == 0xFA))
      return true;
  }
  return false;
}

void startRadar() {
  const int pins[2][2] = {{RADAR_RX_PIN, RADAR_TX_PIN}, {RADAR_TX_PIN, RADAR_RX_PIN}};
  const uint32_t bauds[] = {256000, 115200, 230400, 460800, 57600, 38400, 19200, 9600};
  static uint8_t buf[256];
  Serial1.setRxBufferSize(1024);
  for (auto& p : pins) {
    for (uint32_t baud : bauds) {
      Serial1.begin(baud, SERIAL_8N1, p[0], p[1]);
      delay(30);
      while (Serial1.available()) Serial1.read();
      delay(400);
      int n = 0;
      while (Serial1.available() && n < (int)sizeof(buf)) buf[n++] = Serial1.read();
      bool ok = hasFrameHeader(buf, n);
      Serial.printf("[radar] RX=GPIO%d %6u baud: %3d bayt%s\n", p[0], baud, n, ok ? "  <- gecerli cerceve" : "");
      esp_task_wdt_reset();
      if (ok) {
        if (radar.begin(Serial1)) {
          Serial.printf("[radar] baglandi, firmware %u.%u.%x\n", radar.firmware_major_version,
                        radar.firmware_minor_version, radar.firmware_bugfix_version);
        } else {
          // Veri geliyor ama komutlara cevap yok: ESP TX -> radar RX kablosu temassiz olabilir.
          // Okuma yine calisir, sadece ayar komutlari gonderilemez.
          radar.begin(Serial1, false);
          Serial.println("[radar] veri geliyor ama komut cevabi yok: radar RX kablosunu kontrol et");
        }
        return;
      }
      Serial1.end();
      if (n == 0) break;  // bu pinde hic sinyal yok, diger baud'lari deneme
    }
  }
  Serial.println("[radar] gecerli veri yok: VCC->5V, GND->GND ve TX/RX kablolarini kontrol et");
  Serial1.begin(256000, SERIAL_8N1, RADAR_RX_PIN, RADAR_TX_PIN);
  // Kutuphane stream'i begin() icinde atar; cagrilmazsa read() null'a erisip coker.
  radar.begin(Serial1, false);
}

void readRadar() {
  radar.read();
  if (!radar.isConnected()) return;
  current.presence = radar.presenceDetected();
  current.moving = radar.movingTargetDetected();
  current.stationary = radar.stationaryTargetDetected();
  current.movingDist = radar.movingTargetDistance();
  current.stationaryDist = radar.stationaryTargetDistance();
  current.movingEnergy = radar.movingTargetEnergy();
  current.stationaryEnergy = radar.stationaryTargetEnergy();
}

void startPowerPulse(uint32_t id) {
  Serial.printf("[power] komut %u: guc tusuna basiliyor (%d ms)\n", id, POWER_PULSE_MS);
  digitalWrite(POWER_BTN_PIN, HIGH);
  pulseEndAt = millis() + POWER_PULSE_MS;
  setLed(0, 0, 40);  // optokuplor takili degilse bile gorunur geri bildirim
  ledOffAt = millis() + 2000;
  lastExecutedCmd = id;
  prefs.putUInt("last_cmd", id);
  pendingAck = id;
}

void handleResponse(const String& body) {
  JsonDocument doc;
  if (deserializeJson(doc, body)) return;
  if (doc["ack_ok"].as<bool>()) pendingAck = 0;
  if (const char* pc = doc["pc"]) strlcpy(pcState, pc, sizeof(pcState));
  if (const char* v = doc["disp"]) strlcpy(wantDisp, v, sizeof(wantDisp));
  const char* cmd = doc["command"] | "";
  uint32_t id = doc["id"] | 0;
  if (strcmp(cmd, "press_power") == 0 && id != 0) {
    if (id <= lastExecutedCmd) {
      pendingAck = id;  // zaten calistirildi, sadece onayla
    } else {
      startPowerPulse(id);
    }
  }
}

void sendReport() {
  if (WiFi.status() != WL_CONNECTED) return;

  JsonDocument doc;
  doc["presence"] = current.presence;
  doc["moving"] = current.moving;
  doc["stationary"] = current.stationary;
  doc["moving_dist"] = current.movingDist;
  doc["stationary_dist"] = current.stationaryDist;
  doc["moving_energy"] = current.movingEnergy;
  doc["stationary_energy"] = current.stationaryEnergy;
  doc["radar_ok"] = radar.isConnected();
  doc["out_pin"] = digitalRead(RADAR_OUT_PIN) == HIGH;
  doc["rssi"] = WiFi.RSSI();
  if (pendingAck) doc["ack"] = pendingAck;
  String payload;
  serializeJson(doc, payload);

  HTTPClient http;
  http.setTimeout(3000);
  http.begin(String(BACKEND_URL) + "/api/presence");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);
  int code = http.POST(payload);
  if (code == 200) {
    handleResponse(http.getString());
  }
  Serial.printf("[report] presence=%d moving=%d(%ucm) stationary=%d(%ucm) -> %d\n",
                current.presence, current.moving, current.movingDist,
                current.stationary, current.stationaryDist, code);
  http.end();
}

// Aktif ekran profilini (ve varsa GIF karelerini) indirir. PSRAM varsa oraya alinir.
void fetchDisplay() {
  const size_t cap = psramFound() ? 160 * 1024 : 48 * 1024;
  HTTPClient http;
  http.setTimeout(5000);
  http.begin(String(BACKEND_URL) + "/api/device/display");
  http.addHeader("X-API-Key", API_KEY);
  const char* keys[] = {"X-Display-Version"};
  http.collectHeaders(keys, 1);
  int code = http.GET();
  int size = http.getSize();
  bool ok = false;
  if (code == 200 && size > 2 && (size_t)size <= cap) {
    uint8_t* buf = (uint8_t*)(psramFound() ? ps_malloc(size) : malloc(size));
    if (buf) {
      WiFiClient* stream = http.getStreamPtr();
      size_t got = 0;
      uint32_t start = millis();
      while (got < (size_t)size && millis() - start < 8000) {
        size_t avail = stream->available();
        if (avail) {
          got += stream->readBytes(buf + got, min(avail, (size_t)size - got));
        } else if (!http.connected()) {
          break;
        } else {
          delay(1);
        }
        esp_task_wdt_reset();
      }
      ok = got == (size_t)size && displaySetBundle(buf, size);
      if (!ok) free(buf);
    }
  }
  if (ok) {
    strlcpy(haveDisp, http.header("X-Display-Version").c_str(), sizeof(haveDisp));
    if (!haveDisp[0]) strlcpy(haveDisp, wantDisp, sizeof(haveDisp));
    Serial.printf("[disp] bundle %d bayt, surum %s\n", size, haveDisp);
  } else {
    Serial.printf("[disp] indirilemedi (http %d, %d bayt), 10 sn sonra tekrar\n", code, size);
    dispRetryAt = millis() + 10000;
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  // Native USB: bilgisayar portu acana kadar kisa bekle, acilis loglari kaybolmasin
  for (uint32_t t = millis(); !Serial && millis() - t < 3000;) delay(10);
  delay(200);
  Serial.println("\n[radarwake] basliyor");

  Serial.printf("[radarwake] PSRAM: %u KB\n", ESP.getPsramSize() / 1024);

  esp_task_wdt_init(WDT_TIMEOUT_S, true);
  esp_task_wdt_add(NULL);

  pinMode(POWER_BTN_PIN, OUTPUT);
  digitalWrite(POWER_BTN_PIN, LOW);
  pinMode(RADAR_OUT_PIN, INPUT);
  setLed(0, 0, 0);

  prefs.begin("radarwake", false);
  lastExecutedCmd = prefs.getUInt("last_cmd", 0);

  startRadar();
  displayBegin(OLED_SDA_PIN, OLED_SCL_PIN);

  // Kopma nedeni: 15/204=handshake zaman asimi, 202=auth hatasi, 201=AP yok
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) {
    Serial.printf("[wifi] koptu, reason=%d\n", info.wifi_sta_disconnected.reason);
  }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);

  connectWifi();
}

void loop() {
  esp_task_wdt_reset();
  uint32_t now = millis();

  if (pulseEndAt && (int32_t)(now - pulseEndAt) >= 0) {
    digitalWrite(POWER_BTN_PIN, LOW);
    pulseEndAt = 0;
  }
  if (ledOffAt && (int32_t)(now - ledOffAt) >= 0) {
    setLed(0, 0, 0);
    ledOffAt = 0;
  }

  readRadar();

  // Hedef mesafesi: sabit hedef varsa onun mesafesi (daha kararli), yoksa hareketli hedef
  uint16_t dist = current.stationary && current.stationaryDist ? current.stationaryDist : current.movingDist;
  DisplayData dd = {
      WiFi.status() == WL_CONNECTED,
      WiFi.RSSI(),
      radar.isConnected(),
      current.presence,
      current.moving,
      current.presence ? dist : (uint16_t)0,
      pcState,
      ledOffAt != 0,
  };
  displayUpdate(dd);

  static uint32_t lastWifiTry = 0;
  if (WiFi.status() != WL_CONNECTED && now - lastWifiTry > 30000) {
    lastWifiTry = now;
    connectWifi();
  }

  bool changed = current.presence != lastSentPresence;
  // Biri varken dashboard'daki canli sonar ekrani icin sik, bos odada seyrek rapor
  bool due = now - lastReportAt >= (current.presence ? LIVE_REPORT_INTERVAL_MS : REPORT_INTERVAL_MS);
  bool gapOk = now - lastReportAt >= MIN_REPORT_GAP_MS;
  // Basma surerken rapor gonderme: HTTP bloklarken darbe uzamasin
  if (!pulseEndAt && gapOk && (changed || due || forceReport || pendingAck)) {
    sendReport();
    lastSentPresence = current.presence;
    lastReportAt = millis();
    forceReport = false;
  }

  if (!pulseEndAt && wantDisp[0] && strcmp(wantDisp, haveDisp) != 0 && WiFi.status() == WL_CONNECTED &&
      (int32_t)(millis() - dispRetryAt) >= 0) {
    fetchDisplay();
  }
}
