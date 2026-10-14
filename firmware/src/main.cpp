// radarwake firmware: LD2410C varlik verisini backend'e raporlar,
// backend'den gelen "press_power" komutuyla PC guc tusuna optokuplor uzerinden basar.
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <ld2410.h>
#include <esp_task_wdt.h>

#if __has_include("config.h")
#include "config.h"
#else
#error "firmware/src/config.h yok: config.example.h dosyasini config.h olarak kopyala ve doldur"
#endif

static const uint32_t WDT_TIMEOUT_S = 30;

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

// Radar surekli veri yollar (~10 Hz). Iki pin yonunu de dener: TX/RX ters takildiysa
// kablo degistirmeye gerek kalmaz. Hic bayt gelmiyorsa sorun guc/kablodur.
void startRadar() {
  const int pins[2][2] = {{RADAR_RX_PIN, RADAR_TX_PIN}, {RADAR_TX_PIN, RADAR_RX_PIN}};
  Serial1.setRxBufferSize(1024);
  for (auto& p : pins) {
    Serial1.begin(256000, SERIAL_8N1, p[0], p[1]);
    delay(50);
    while (Serial1.available()) Serial1.read();
    delay(1000);
    int bytes = Serial1.available();
    Serial.printf("[radar] RX=GPIO%d TX=GPIO%d: 1 sn'de %d bayt\n", p[0], p[1], bytes);
    if (bytes > 0 && radar.begin(Serial1)) {
      Serial.printf("[radar] baglandi, firmware %u.%u.%x\n", radar.firmware_major_version,
                    radar.firmware_minor_version, radar.firmware_bugfix_version);
      return;
    }
    Serial1.end();
  }
  Serial.println("[radar] cevap yok: VCC->5V, GND->G ve TX/RX kablolarini kontrol et");
  Serial1.begin(256000, SERIAL_8N1, RADAR_RX_PIN, RADAR_TX_PIN);
  // Kutuphane stream'i begin() icinde atar; cagrilmazsa read() null'a erisip coker.
  // Radar sonradan baglanirsa da veri okunmaya baslar.
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

void setup() {
  Serial.begin(115200);
  // Native USB: bilgisayar portu acana kadar kisa bekle, acilis loglari kaybolmasin
  for (uint32_t t = millis(); !Serial && millis() - t < 3000;) delay(10);
  delay(200);
  Serial.println("\n[radarwake] basliyor");

  esp_task_wdt_init(WDT_TIMEOUT_S, true);
  esp_task_wdt_add(NULL);

  pinMode(POWER_BTN_PIN, OUTPUT);
  digitalWrite(POWER_BTN_PIN, LOW);
  pinMode(RADAR_OUT_PIN, INPUT);
  setLed(0, 0, 0);

  prefs.begin("radarwake", false);
  lastExecutedCmd = prefs.getUInt("last_cmd", 0);

  startRadar();

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

  static uint32_t lastWifiTry = 0;
  if (WiFi.status() != WL_CONNECTED && now - lastWifiTry > 30000) {
    lastWifiTry = now;
    connectWifi();
  }

  bool changed = current.presence != lastSentPresence;
  bool due = now - lastReportAt >= REPORT_INTERVAL_MS;
  bool gapOk = now - lastReportAt >= MIN_REPORT_GAP_MS;
  // Basma surerken rapor gonderme: HTTP bloklarken darbe uzamasin
  if (!pulseEndAt && gapOk && (changed || due || forceReport || pendingAck)) {
    sendReport();
    lastSentPresence = current.presence;
    lastReportAt = millis();
    forceReport = false;
  }
}
