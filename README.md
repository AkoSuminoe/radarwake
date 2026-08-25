# radarwake

ESP32 + LD2410C mmWave radar ile varlik algilama, uzaktan PC uyandirma (WOL) ve
uykuya alma sistemi. PC ayni zamanda ev sunucusu (Windows 11 Pro, WSL2, Docker,
Caddy, Cloudflare Tunnel) oldugu icin servis kendi izole Docker container'inda calisir.

> Durum: iskelet. Kod henuz yazilmadi, dosya yapisi hazir.

## Mimari

```
LD2410C --UART--> ESP32 --WiFi/HTTP--> Backend API (Docker)
                                            |
                                            v
                                 Presence state + history (SQLite)
                                            |
                                            v
                              WOL magic packet -> hedef PC (ayni LAN)
                                            ^
                                            |
                         Web dashboard (auth) --HTTPS--> Backend API
                                            ^
                                            |
                      (Faz 2) Telefon BLE ------> ESP32 dogrudan
```

## Dizin yapisi

```
firmware/     ESP32 tarafi (PlatformIO / Arduino)
backend/      FastAPI servisi (Docker)
frontend/     Next.js dashboard
pc-agent/     PC uzerinde calisan sleep/shutdown ajani
docs/         semalar, notlar
```

## Teknoloji

| Katman   | Secim                                              |
|----------|----------------------------------------------------|
| Firmware | ESP32, Arduino framework, LD2410C UART @256000     |
| Backend  | FastAPI + SQLite (Postgres'e gecis yolu acik)      |
| Frontend | Next.js (berktan.dev ile ayni stack)               |
| Auth     | JWT, tek kullanicili                               |
| Proxy    | Mevcut Caddy + Cloudflare Tunnel                    |
| WOL      | `wakeonlan` kutuphanesi                             |

## API taslagi

| Endpoint                 | Yetki           | Not                                  |
|--------------------------|-----------------|--------------------------------------|
| `POST /api/auth/login`   | -               | JWT doner, rate limit'li             |
| `POST /api/presence`     | `X-API-Key`     | ESP32 raporu, **sadece LAN**         |
| `GET  /api/presence/history` | JWT         | dashboard grafigi                    |
| `GET  /api/pc/status`    | JWT             | bilinen PC durumu                    |
| `POST /api/pc/wake`      | JWT             | WOL magic packet                     |
| `POST /api/pc/sleep`     | JWT             | PC ajanina imzali komut              |

## Guvenlik kararlari (ve nedenleri)

- **Hicbir yetkisiz endpoint guc islemi tetikleyemez.** Durum degistiren her
  endpoint gecerli token ister. Aksi halde ag icindeki herhangi bir cihaz
  PC'yi acip kapatabilir.
- **ESP32 -> backend ucu da tokenli.** Sadece veri yaziyor olsa bile yetkisiz
  yazma ucu bir suistimal vektorudur: log spam'i ve sahte varlik verisi
  otomatik uyku/uyandirma mantigini kandirabilir.
- **Ingestion ucu tunnel'a acilmaz.** ESP32 evden cikmadigi icin `/api/presence`
  yalnizca LAN arayuzunden dinler. Cloudflare Tunnel'dan sadece dashboard gecer.
  Uzaktan raporlama gerekirse o zaman yeniden degerlendirilir.
- **Rate limiting** login ve presence uclarinda; brute force ve spam icin.
- **Docker izolasyonu:** servis kendi container ve network'unde calisir, buradaki
  bir zafiyet sunucudaki diger servislere siframaz.
- **Sifreler hash'li** (argon2/bcrypt), duz metin saklanmaz. Tek kullanici oldugu
  icin klasik parola yerine uzun rastgele token da tercih edilebilir.
- **Secret'lar repoya girmez:** `.env` + `.gitignore`, gerekli degiskenler
  `.env.example` dosyalarinda belgeli.
- **Hedef MAC adresi config'te**, frontend'e veya koda gomulmez.
- **Otomatik uyku varsayilan kapali** (`AUTO_SLEEP_ENABLED=false`). Varlik mantigi
  yanilirsa yikici oldugu icin opt-in.

## Yol haritasi

1. Backend iskeleti + auth + SQLite + Docker Compose, WOL ucu curl ile test edilir
2. ESP32 firmware: LD2410C UART okuma, API key ile POST
3. Dashboard: login, durum gorunumu, manuel uyandirma
4. History grafigi + debounce mantigi
5. Caddy entegrasyonu + Cloudflare Tunnel (sadece dashboard)
6. (Faz 2) Telefondan BLE ile dogrudan kontrol

## Gerekli eklentiler / bagimliliklar

**VS Code** (`.vscode/extensions.json`)

- `platformio.platformio-ide` - ESP32 derleme/yukleme
- `ms-vscode.cpptools` - C/C++ IntelliSense
- `ms-python.python`, `ms-python.vscode-pylance` - backend
- `ms-azuretools.vscode-docker` - container yonetimi
- `bradlc.vscode-tailwindcss`, `dbaeumer.vscode-eslint` - frontend
- `ms-vscode.powershell` - PC ajani / Windows gorevleri
- `editorconfig.editorconfig`, `github.vscode-pull-request-github`

**PlatformIO kutuphaneleri**

- `ncmreynolds/ld2410` - LD2410C UART protokolu
- `bblanchon/ArduinoJson` - JSON govdesi
- WiFi / HTTPClient / Preferences ESP32 core ile gelir

**Backend (Python 3.12)**

- `fastapi`, `uvicorn[standard]`, `sqlalchemy`, `pydantic-settings`
- `python-jose[cryptography]` (JWT), `passlib[argon2]` (hash)
- `wakeonlan`, `slowapi` (rate limit)

**PC tarafi**

- BIOS/UEFI'de Wake-on-LAN acik
- Ag karti: "Magic Packet ile uyandir" acik, **Fast Startup kapali**
- Router'da PC icin DHCP rezervasyonu

## Lisans

MIT
