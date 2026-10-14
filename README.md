<div align="center">

# radarwake

**Presence-aware PC control with a 24 GHz mmWave radar.**

[![CI](https://github.com/AkoSuminoe/radarwake/actions/workflows/ci.yml/badge.svg)](https://github.com/AkoSuminoe/radarwake/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/AkoSuminoe/radarwake?sort=semver)](https://github.com/AkoSuminoe/radarwake/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![ESP32-S3](https://img.shields.io/badge/ESP32--S3-PlatformIO-orange)
![Docker](https://img.shields.io/badge/server-Docker-2496ED)

</div>

An ESP32-S3 with an LD2410C mmWave radar detects whether someone is at the desk, reports
it to a small backend on a home server, and can press the desktop's power button through
an optocoupler. A LAN-only, password protected dashboard shows a live sonar view and lets
you wake, sleep or shut down the PC from your phone.

## Features

- **Live sonar dashboard:** range, motion and signal strength, updated every second.
- **Wake from anywhere in the house:** the ESP32 presses the real power button, so it works
  from off, sleep or hibernate, and on Wi-Fi-only PCs where Wake-on-LAN does not.
- **Sleep / shut down** through a small signed agent on the PC.
- **OLED status screen** on the sensor (optional).
- **Private by design:** home network only, argon2 password, signed device traffic,
  hardened container.
- **One-line installers** for the server (Linux / WSL2) and the Windows agent.

## Quick start

**1. Server** (always-on Linux box, Raspberry Pi or WSL2 with Docker):

```bash
curl -fsSL https://raw.githubusercontent.com/AkoSuminoe/radarwake/main/scripts/install.sh | bash
```

It asks for the server's LAN IP, the PC's IP and a dashboard password, generates all
secrets and starts the container. Run it again any time to update.

If the server is a Windows machine running WSL2, also run this once in an elevated
PowerShell on Windows (mirrored networking, firewall, start at boot):

```powershell
irm https://github.com/AkoSuminoe/radarwake/releases/latest/download/wsl-server-setup.ps1 | iex
```

**2. Workstation agent** (the PC you want to wake/sleep), elevated PowerShell:

```powershell
irm https://github.com/AkoSuminoe/radarwake/releases/latest/download/get-agent.ps1 | iex
```

Enter the server IP and the agent secret printed by the server installer. No Python
needed; the agent runs at boot as a background task. Remove it with
`& "$env:ProgramFiles\radarwake-agent\uninstall.ps1"`.

**3. Sensor:** wire the radar (see [Hardware](#hardware)), put the Wi-Fi details, the
server URL and the ESP32 API key into `firmware/src/config.h` and flash it with PlatformIO
(see [Firmware](#1-firmware)).

**4. Phone:** open `http://<server-ip>:8000` on the home Wi-Fi and sign in.

## How it works

- **Server (always on):** a laptop running Docker inside WSL2. Backend and dashboard run
  in a single isolated container, reachable **only from the home network**.
- **Workstation (target):** the desktop being woken/slept. It is on Wi-Fi, so Wake-on-LAN
  is not used; the ESP32 presses the motherboard power switch instead.
- **Sensor node:** ESP32-S3 + LD2410C (+ optional 0.96" OLED) next to the desk, powered by
  a USB charger.

## Architecture

```
LD2410C --UART--> ESP32-S3 --Wi-Fi/HTTP :8001--> Backend (server, Docker)
   OLED <--I2C---/   |   <-- "press_power" in reply --   |  SQLite: history + state
                     |                                   |
                 PC817 optocoupler                       |  HMAC-signed sleep/shutdown
                     |                                   v
           motherboard PWR_SW  <--  workstation -- pc-agent :8765
                                         |  heartbeat (30 s) --> Backend :8001

 Phone / browser (home Wi-Fi) --HTTP--> http://<server-ip>:8000   (password login)
```

- **Wake:** dashboard `POST /api/pc/wake` -> backend queues a command -> the ESP32 receives
  it in the reply to its next report -> pulses GPIO4 for 300 ms -> the PC powers on.
  The ESP32 never listens on a port.
- **Is the PC on?** Yes if the pc-agent heartbeat is newer than 90 s.
- **Sleep / shut down:** the backend sends an HMAC-signed request to the pc-agent.

## Hardware

Board: ESP32-S3 N16R8 DevKitC-style clone (YD-ESP32-S3) with two USB-C ports.

> **Note:** on this board the `5Vin` pin does **not** output 5 V from USB until the
> `IN-OUT` solder pads next to it are bridged. Bridge them before powering the radar
> from `5Vin`.

Use the port labelled **USB** (native USB-Serial/JTAG) for flashing and the serial
monitor; the firmware is built for it. For permanent use, plug the board into a 5 V USB
charger, not into the workstation (its USB power drops when the PC is off).

**LD2410C radar**

| LD2410C | ESP32-S3 |
|---------|----------|
| VCC | 5Vin |
| GND | GND |
| TX  | GPIO18 |
| RX  | GPIO17 |
| OUT | GPIO5 (optional) |

The firmware scans both pin directions and common baud rates at boot, so swapped TX/RX
still works.

**0.96" SSD1306 OLED (optional)**

| OLED | ESP32-S3 |
|------|----------|
| GND | GND |
| VDD | 3V3 |
| SCK | GPIO9 |
| SDA | GPIO8 |

Shows a mini sonar, range, motion state, signal strength, Wi-Fi bars and PC state. It turns
off after 5 minutes with nobody around and shifts by a pixel every minute to limit OLED
burn-in. For 1.3" SH1106 panels, add `#define OLED_SH1106` to `config.h`.

**PC817 optocoupler module -> power switch**

Use a module rated for **3.3 V input** (3-5 V); one channel is enough.

```
ESP GPIO4 --> module IN
ESP GND   --> module GND (input side)
module output (collector) --> motherboard PWR_SW +
module output (emitter)   --> motherboard PWR_SW -
```

Wire it in parallel with the case button so that keeps working. The optocoupler keeps
the ESP32 and the PC electrically isolated. Until it is installed, a wake command only
lights the board's RGB LED blue.

Pins to avoid: 0/3/45/46 (strapping), 19/20 (native USB), 43/44 (UART0), 35-37 (octal PSRAM).

## Repository layout

```
firmware/   ESP32-S3 (PlatformIO, Arduino core 2.x)
backend/    FastAPI service (Docker on the server)
frontend/   Next.js dashboard (static export, bundled into the backend image)
pc-agent/   sleep/shutdown + heartbeat agent for the workstation (Windows, stdlib only)
scripts/    one-line installers (server, WSL2 host, agent)
```

Releases are built by GitHub Actions on every `v*` tag: the Windows agent exe/zip, the
multi-arch container image and the installer scripts. See [CHANGELOG.md](CHANGELOG.md).

## Setup

### 1. Firmware

1. Copy `firmware/src/config.example.h` to `config.h` and fill in Wi-Fi (2.4 GHz), the
   server LAN IP and `API_KEY`.
2. Connect the **USB** port and run `pio run -t upload -t monitor`
   (if `pio` is not on PATH: `~/.platformio/penv/Scripts/pio`). The first flash may need
   BOOT held while tapping RST.
3. Expect `[radar] RX=GPIO18 256000 baud ... <- valid frame` and `[report] ... -> 200`.

### 2. Backend (server)

`scripts/install.sh` (see [Quick start](#quick-start)) does all of this. Manual setup:

```bash
cd backend
python -m venv .venv && .venv/bin/pip install pwdlib[argon2]
.venv/bin/python scripts/hash_password.py   # prints ADMIN_PASSWORD_HASH and secrets
cp .env.example .env                        # fill in the values
cd .. && cp .env.example .env               # LAN_IP=<server LAN IP>
docker compose up -d --build
```

- Ports 8000 (dashboard) and 8001 (ESP32 + agent) are bound to `LAN_IP` only.
- On WSL2 with native Docker use `networkingMode=mirrored` and allow 8000/8001 from the
  LAN subnet in both the Hyper-V firewall and Windows Firewall
  (`scripts/wsl-server-setup.ps1`). Enable systemd in WSL so Docker starts with the distro.
- Prebuilt image: `ghcr.io/akosuminoe/radarwake` (amd64, arm64); `--build` builds from source.
- Reserve DHCP addresses for the server, the workstation and the ESP32.

### 3. pc-agent (workstation, elevated PowerShell)

`get-agent.ps1` (see [Quick start](#quick-start)) downloads the release zip and runs the
installer. From a checkout (uses `agent.py` + python.org Python instead of the exe):

```powershell
cd pc-agent
powershell -ExecutionPolicy Bypass -File .\install.ps1 -ServerIp <server-ip> -PowerButtonDoNothing -DisableHibernate
```

- Installs to `C:\Program Files\radarwake-agent`; `config.json` there is readable by
  Administrators and SYSTEM only. Prompts for the secret if no config exists.
- Runs at boot as SYSTEM (before login), restarts on failure, firewall-limited to the server.
- `-PowerButtonDoNothing`: a stray press on a running PC does nothing; waking from sleep or
  power-on from off still works because that is handled by the firmware.
- `-DisableHibernate`: makes "sleep" a real S3 sleep instead of hibernation.
- The release exe needs no Python; the `agent.py` fallback needs python.org Python
  installed for all users.

### 4. Phone

Open `http://<server-ip>:8000` on the home Wi-Fi and sign in. In Safari, Share -> **Add to
Home Screen** opens it like an app. It does not work outside the home network by design;
Tailscale would be the safe way to add remote access later.

## Dashboard

- **Presence scan:** a live sonar view (1 s updates while someone is present). The LD2410C
  measures range, not bearing, so a target is drawn as an arc at the measured distance
  across the field of view, with a fading echo trail. Range, motion and signal readouts.
- **Workstation:** online / offline / booting, plus Wake, Sleep and Shut down. Wake is only
  enabled while the PC is off; Sleep and Shut down only while it is on.
- **Activity:** occupancy timeline for the last 24 hours.

Development: `cd frontend && npm install && npm run build` produces `out/`. For a local run,
copy it to `backend/static` and start the backend.

## API

| Endpoint | Port | Auth | Notes |
|---|---|---|---|
| `POST /api/auth/login` | 8000 | - | JWT + httpOnly cookie, rate limited |
| `POST /api/auth/logout` | 8000 | - | clears the cookie |
| `GET  /api/auth/me` | 8000 | JWT | session check |
| `GET  /api/presence/live` | 8000 | JWT | latest radar reading (in memory) |
| `GET  /api/presence/current` | 8000 | JWT | debounced presence + sensor state |
| `GET  /api/presence/history?hours=24` | 8000 | JWT | timeline data |
| `GET  /api/pc/status` | 8000 | JWT | `on` / `off` / `waking` |
| `POST /api/pc/wake` | 8000 | JWT | only while off; 409 otherwise |
| `POST /api/pc/sleep` | 8000 | JWT | `{"action":"sleep"\|"shutdown"}` |
| `POST /api/presence` | 8001 | `X-API-Key` | ESP32 report; reply carries commands + PC state |
| `POST /api/pc/heartbeat` | 8001 | HMAC | pc-agent |
| `GET  /api/health` | both | - | healthcheck |

Each route is only served on its own port; the other port returns 404.

## Security decisions

- **No unauthenticated endpoint can trigger a power action.** Every state-changing route
  requires a JWT, an API key or an HMAC signature.
- **Nothing is exposed to the internet.** Both ports are bound to the server's LAN IP;
  no tunnel or port forwarding. The Tailscale interface is excluded as well.
- **Host header allow-list** (`ALLOWED_HOSTS`) against DNS rebinding. Rate limiting uses the
  socket address and ignores forwarding headers.
- **A running PC never gets a power-button press.** Wake returns 409 while a heartbeat is
  present or a press is in flight. The ESP32 stores the last executed command id in NVS so
  a resend after a reboot is never executed twice. The pulse is 300 ms, far from a 5 s
  forced power-off.
- **The ESP32 endpoint is authenticated**, because fake presence data could drive the
  automatic sleep/wake logic.
- **pc-agent commands are HMAC-signed** with a ±30 s window and a nonce cache against replay,
  and the agent's firewall rule only admits the server.
- **Dashboard session:** argon2-hashed password (min. 12 characters), JWT in an httpOnly,
  SameSite=Strict cookie, plus a required `X-Radarwake` header on cookie-authenticated POSTs.
- **Plain HTTP on the LAN is a deliberate trade-off.** Traffic stays inside the WPA2-encrypted
  home Wi-Fi; HTTPS with a local certificate can be added later (`COOKIE_SECURE=true`).
- **Container hardening:** read-only filesystem, `cap_drop: ALL`, `no-new-privileges`,
  non-root user.
- **Secrets never enter the repo** (`.env`, `config.h` and `config.json` are git-ignored).
- **Automatic sleep and wake are off by default** (`AUTO_SLEEP_ENABLED`, `AUTO_WAKE_ENABLED`);
  enable them after manual testing.

## Roadmap

1. ~~Backend: auth, SQLite, Docker Compose, power command queue~~
2. ~~Firmware: LD2410C, authenticated reports, power button pulse~~
3. ~~pc-agent: heartbeat, signed sleep/shutdown~~
4. ~~Dashboard: live sonar, workstation controls, 24 h activity~~
5. ~~LAN-only deployment on the server~~
6. Optocoupler install and end-to-end wake test
7. Radar tuning (gates, sensitivity) and LD2410C engineering mode for per-zone detection
   (desk vs. bed)
8. Phone control over BLE directly to the ESP32

## Development

```bash
cd backend
pip install -r requirements-dev.txt
python -m pytest -q
```

## Dependencies

- **Firmware:** `ncmreynolds/ld2410`, `bblanchon/ArduinoJson`, `olikraus/U8g2`.
- **Backend (Python 3.12):** `fastapi`, `uvicorn`, `sqlalchemy`, `pydantic-settings`,
  `PyJWT`, `pwdlib[argon2]`, `httpx`.
- **Dashboard:** Next.js 15, React 19 (static export).
- **pc-agent:** Python standard library only.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## License

[MIT](LICENSE)
