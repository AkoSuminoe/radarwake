// Bu dosyayi config.h olarak kopyala ve doldur. config.h repoya girmez.
#pragma once

// --- WiFi (ESP32 sadece 2.4 GHz destekler) ---
#define WIFI_SSID     ""
#define WIFI_PASSWORD ""

// --- Backend (laptop LAN IP'si, ingest portu) ---
#define BACKEND_URL   "http://192.168.1.50:8001"
#define API_KEY       ""          // backend .env'deki ESP32_API_KEY ile ayni

// --- Pinler (ESP32-S3-DevKitC-1) ---
#define RADAR_RX_PIN  18          // LD2410C TX buraya
#define RADAR_TX_PIN  17          // LD2410C RX buraya
#define RADAR_OUT_PIN 5           // LD2410C OUT (dijital varlik)
#define POWER_BTN_PIN 4           // PC817 anot (330R uzerinden)
#define RGB_LED_PIN   48          // dahili WS2812 (bazi kartlarda 38)
#define OLED_SDA_PIN  8           // 0.96" SSD1306 OLED (I2C)
#define OLED_SCL_PIN  9
// #define OLED_SH1106             // 1.3" SH1106 ekranlar icin ac

// --- Zamanlama ---
#define REPORT_INTERVAL_MS  10000 // bos odada / degisiklik yoksa heartbeat raporu
#define LIVE_REPORT_INTERVAL_MS 1000 // biri varken (dashboard canli sonar)
#define MIN_REPORT_GAP_MS   1000  // degisiklikte bile en fazla saniyede 1
#define POWER_PULSE_MS      300   // kisa basma; ~5 sn zorla kapatir, asla uzatma
