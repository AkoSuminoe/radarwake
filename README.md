# radarwake

ESP32-S3 + LD2410C mmWave radar ile varlik algilama, masaustu PC'yi uzaktan acma ve
uykuya alma sistemi.

- **Laptop (server, hep acik):** Windows 11 Pro, Docker Desktop (WSL2). Backend ve dashboard
  tek bir izole container'da calisir. **Sadece ev agindan erisilir**, internete acilmaz.
- **Masaustu (hedef PC):** acilip kapatilan makine. Aga Wi-Fi ile bagli oldugu icin WOL
  kullanilmaz; ESP32 anakartin guc tusuna optokuplorla "basar".
- **ESP32-S3-DevKitC-1 + LD2410C:** masaustunun yaninda, 5V telefon sarjiyla beslenir.

## Mimari

```
LD2410C --UART--> ESP32-S3 --WiFi/HTTP :8001--> Backend (laptop, Docker)
                     |   <-- cevapta "press_power" --     |  SQLite: presence + durum
                     |                                    |
                 PC817 optokuplor                         |  HMAC imzali sleep/shutdown
                     |                                    v
              anakart PWR_SW  <-- masaustu PC -- pc-agent :8765
                                       |  heartbeat (30 sn) --> Backend :8001
                                       
 Telefon/tarayici (ev Wi-Fi'si) --HTTP--> http://192.168.1.146:8000  (sifreli giris)
```

- **Uyandirma:** dashboard `POST /api/pc/wake` -> backend komutu kuyruga ekler -> ESP32 bir
  sonraki raporunun cevabinda komutu alir -> GPIO4'u 300 ms tetikler -> PC acilir.
  ESP'de dinleyen port yoktur.
- **PC acik mi:** pc-agent'in heartbeat'i 90 saniyeden yeniyse acik sayilir.
- **Uyutma:** backend pc-agent'a HMAC imzali istek gonderir.

## Donanim baglantisi

**USB:** Kod yuklemek ve seri monitor icin kartin **USB** yazan USB-C portu kullanilir
(native USB, Windows'ta "USB Serial Device (COMx)" olarak gorunur; firmware buna gore
derlenir). COM portu CH343 surucusu ister, kullanilmaz.
Kalici kullanimda kart 5V telefon sarjina takilir. Masaustune takili birakilmaz, cunku
PC kapaninca USB'deki guc kesilir.

**LD2410C -> ESP32-S3**

| LD2410C | ESP32-S3 | Not |
|---------|----------|-----|
| VCC | 5V | radar 5V ister |
| GND | GND | |
| TX  | GPIO18 | UART1 RX (capraz) |
| RX  | GPIO17 | UART1 TX (capraz) |
| OUT | GPIO5  | dijital varlik, istege bagli |

**PC817 optokuplor -> anakart guc tusu**

```
ESP GPIO4 --[330R]--> PC817 pin1 (anot)
ESP GND   ----------> PC817 pin2 (katot)
PC817 pin4 (kollektor) --> anakart PWR_SW +
PC817 pin3 (emitor)    --> anakart PWR_SW -   (topraga giden pin)
```

- Kasanin kendi tusu de calissin diye ayni pinlere paralel baglanir.
- ESP GND'si PC topragina dogrudan baglanmaz, izolasyonu optokuplor saglar.
- Parca gelene kadar "basma" komutu kartin RGB LED'ini mavi yakar.
- Alisveris listesi: PC817 (tek basina ya da 1 kanalli modul), 330R direnc, dupont kablolar.

Kullanilmayacak pinler: 0/3/45/46 (strapping), 19/20 (native USB), 43/44 (COM'un UART0'i),
35-37 (octal PSRAM).

## Dizin yapisi

```
firmware/     ESP32-S3 (PlatformIO / Arduino)
backend/      FastAPI servisi (Docker, laptop)
pc-agent/     masaustunde calisan sleep/shutdown + heartbeat ajani
frontend/     Next.js dashboard (static export, backend image'ina gomulur)
docs/         semalar, notlar
```

## Kurulum

### 1. Firmware (masaustunde, VS Code + PlatformIO)

1. `firmware/src/config.example.h` dosyasini `config.h` olarak kopyala. Wi-Fi bilgilerini
   (2.4 GHz), laptop IP'sini ve `API_KEY`'i doldur.
2. Karti USB portundan bagla, sonra: `pio run -t upload -t monitor`.
3. Seri monitorde `[radar] baglandi` ve `[report] ... -> 200` satirlari gorulmeli.

### 2. Backend (laptopta)

```powershell
cd backend
python -m venv .venv; .venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python scripts\hash_password.py   # cikan satirlari backend\.env'e yaz
copy .env.example .env                          # kalan alanlari doldur
cd ..; copy .env.example .env                   # LAN_IP
docker compose up -d --build
```

- Windows Firewall'da TCP 8000 ve 8001 portlarini sadece yerel subnet'e ac.
- Router'da laptop, masaustu ve ESP32 icin DHCP rezervasyonu yap.

### 3. PC ajani (masaustunde, yonetici PowerShell)

```powershell
cd pc-agent
copy config.example.json config.json   # backend_url, secret, allowed_ips
powershell -ExecutionPolicy Bypass -File .\install.ps1 -LaptopIp 192.168.1.146 -PowerButtonDoNothing -DisableHibernate
```

- `-PowerButtonDoNothing`: acik PC'ye yanlislikla basma komutu gelse bile PC kapanmaz.
  Kapali ya da uykudaki PC yine acilir. Kapatmayi Baslat menusunden ya da dashboard'dan yaparsin.
- `-DisableHibernate`: sleep komutu hazirda bekletme yerine gercek uyku yapar.
  Fast Startup da kapanir.
- python.org Python'u "tum kullanicilar icin" kurulmali, cunku ajan SYSTEM olarak calisir.

### 4. Telefondan erisim

1. Telefon ev Wi-Fi'sine bagliyken `http://192.168.1.146:8000` adresini ac, giris yap.
2. Safari'de Paylas -> **Ana Ekrana Ekle** dersen uygulama gibi acilir.

Evden disarida calismaz, bu bilincli bir tercih. Ileride disaridan erismek istersen
en guvenli yol Tailscale'dir: siteyi internete acmadan sadece kendi cihazlarin erisir.

## Dashboard

- Giris: kullanici adi + sifre (argon2 hash, en az 12 karakter). Token **httpOnly cookie**'de
  tutulur (7 gun), JS erisemez. Login 5 deneme/dakika ile sinirli.
  Cookie ile gelen POST'lar ayrica `X-Radarwake: 1` header'i ister (CSRF korumasi).
- **Uyandir** sadece PC kapaliyken, **Uyut / Kapat** sadece PC acikken aktif olur.
- Oda karti: radar durumu, mesafe ve son 24 saatin varlik zaman cizelgesi.

Gelistirme: `cd frontend; npm install; npm run build` -> `out/`. Yerel test icin `out/`
klasorunu `backend/static` olarak kopyalayip backend'i `COOKIE_SECURE=false` ile calistir.

## API

| Endpoint | Port | Yetki | Not |
|---|---|---|---|
| `POST /api/auth/login` | 8000 | - | JWT doner + httpOnly cookie, rate limit'li |
| `POST /api/auth/logout` | 8000 | - | cookie'yi siler |
| `GET  /api/auth/me` | 8000 | JWT | oturum kontrolu |
| `GET  /api/presence/current` | 8000 | JWT | debounce'lu varlik + sensor durumu |
| `GET  /api/presence/history?hours=24` | 8000 | JWT | dashboard grafigi |
| `GET  /api/pc/status` | 8000 | JWT | `on` / `off` / `waking` |
| `POST /api/pc/wake` | 8000 | JWT | sadece PC kapaliyken; aciksa 409 |
| `POST /api/pc/sleep` | 8000 | JWT | `{"action":"sleep"\|"shutdown"}` |
| `POST /api/presence` | 8001 | `X-API-Key` | ESP32 raporu, cevapta komut |
| `POST /api/pc/heartbeat` | 8001 | HMAC | pc-agent |
| `GET  /api/health` | ikisi | - | healthcheck |

Her route sadece kendi portundan kabul edilir, diger porttan 404 doner.

## Guvenlik kararlari (ve nedenleri)

- **Hicbir yetkisiz endpoint guc islemi tetikleyemez.** Durum degistiren her endpoint
  JWT, API key ya da HMAC imzasi ister.
- **Acik PC'ye basma komutu gonderilmez.** Heartbeat varken ya da bir basma isleniyorken
  wake 409 doner. ESP32 son calistirdigi komut id'sini NVS'te saklar ve tekrar gelen
  komutu ikinci kez calistirmaz. Darbe 300 ms'dir, 5 saniyelik zorla kapatma riski yoktur.
- **ESP32 -> backend ucu tokenli.** Sahte varlik verisi otomatik uyku/uyandirma mantigini
  kandirabilir.
- **Internete acik hicbir sey yok.** Iki port da sadece laptopun LAN IP'sine publish edilir
  (Tailscale ve diger arayuzlerden erisilemez). Tunnel/port yonlendirme kullanilmaz.
- **Host kontrolu.** Sadece `ALLOWED_HOSTS` icindeki adreslerle gelen istekler kabul edilir
  (DNS rebinding'e karsi). Rate limit proxy header'larina guvenmez.
- **Duz HTTP, bilincli tercih.** Trafik ev Wi-Fi'sinin WPA2 sifrelemesi icinde kalir.
  HTTPS istenirse ileride yerel sertifika eklenebilir (`COOKIE_SECURE=true`).
- **pc-agent komutlari HMAC imzali.** ±30 saniye zaman penceresi ve nonce ile replay
  engellenir. Firewall kurali sadece laptop IP'sine izin verir.
- **Rate limiting** login ve presence uclarinda var.
- **Docker izolasyonu:** container read-only, `cap_drop: ALL`, `no-new-privileges`, root
  olmayan kullanici ile calisir.
- **Parolalar argon2 ile hash'lenir.** Secret'lar repoya girmez (`.env`, `config.h`,
  `config.json` gitignore'da).
- **Otomatik uyku ve uyandirma varsayilan olarak kapali** (`AUTO_SLEEP_ENABLED`,
  `AUTO_WAKE_ENABLED`). Manuel test bittikten sonra acilir.

## Yol haritasi

1. ~~Backend: auth, SQLite, Docker Compose, guc komut kuyrugu~~
2. ~~ESP32 firmware: LD2410C okuma, API key ile rapor, guc tusu darbesi~~
3. ~~PC ajani: heartbeat, imzali sleep/shutdown~~
4. Optokuplor montaji ve uctan uca test
5. ~~Dashboard: login, durum, uyandir/uyut/kapat, 24 saatlik zaman cizelgesi~~
6. Laptopta deploy (sadece LAN)
7. (Faz 2) Telefondan BLE ile dogrudan kontrol

## Gelistirme

```powershell
cd backend
.venv\Scripts\pip install -r requirements-dev.txt
.venv\Scripts\python -m pytest -q
```

## Bagimliliklar

- **Firmware:** `ncmreynolds/ld2410`, `bblanchon/ArduinoJson`. WiFi, HTTPClient ve
  Preferences ESP32 core ile gelir.
- **Backend (Python 3.12):** `fastapi`, `uvicorn`, `sqlalchemy`, `pydantic-settings`,
  `PyJWT`, `pwdlib[argon2]`, `httpx`.
- **pc-agent:** sadece Python stdlib.
- **VS Code:** `.vscode/extensions.json` icindeki eklentiler.

## Lisans

MIT
