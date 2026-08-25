# radarwake

ESP32 + LD2410C mmWave radar ile PC'yi uzaktan uyandirma (Wake-on-LAN) ve
odada kimse kalmayinca otomatik kapatma sistemi.

## Yapi

```
firmware/    ESP32 tarafi (PlatformIO / Arduino)
pc-agent/    PC tarafinda calisacak kapatma ajani
docs/        semalar, notlar
```

## Donanim

| LD2410C | ESP32   |
|---------|---------|
| VCC     | 5V      |
| GND     | GND     |
| TX      | GPIO16  |
| RX      | GPIO17  |
| OUT     | GPIO27  |

LD2410C varsayilan UART hizi: 256000 baud.

## Gerekli eklentiler / kutuphaneler

**VS Code eklentileri** (`.vscode/extensions.json` icinde de tanimli)

- `platformio.platformio-ide` - ESP32 derleme ve yukleme
- `ms-vscode.cpptools` - C/C++ IntelliSense
- `ms-python.python` + `ms-python.vscode-pylance` - pc-agent icin
- `ms-vscode.powershell` - Windows servis/gorev scriptleri
- `editorconfig.editorconfig`
- `github.vscode-pull-request-github`

**Arduino / PlatformIO kutuphaneleri**

- `ncmreynolds/ld2410` - LD2410C UART protokolu
- `bblanchon/ArduinoJson` - web API'si icin JSON
- WiFi, WebServer, Preferences, HTTPClient, ESPmDNS - ESP32 core ile gelir
  (ayrica kurulum gerekmez)

**PC tarafi**

- Python 3.11+ (ajan icin, harici bagimlilik yok - `http.server` yeterli)
- BIOS/UEFI'de Wake-on-LAN acik olmali
- Ag karti ayarlarinda "Magic Packet ile uyandir" ve "Fast Startup" kapali

## Kurulum

TODO

## Lisans

MIT
