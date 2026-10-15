# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/).

## [0.2.1] - 2026-10-15

### Fixed

- Reports returned 500 forever once the history reached id 1000: the retention cleanup
  compared a timezone-naive SQLite timestamp with an aware one. The failed insert rolled
  back, so every later report hit the same id.

## [0.2.0] - 2026-10-15

### Added

- **OLED screen profiles:** unlimited screens in six layouts (calm status, sonar, clock,
  GIF, GIF + distance, GIF + corner), managed from a new **Display** tab with live
  previews. Activate one, rotate between several, or pick a screen for an empty room.
- **GIF library:** upload GIF/PNG/WebP from the phone; the server converts it to 1-bit
  frames (dither or solid, fit or fill, invert, brightness). Uploads stay on the server.
- **Clock layout** with NTP time and a time zone chosen in the dashboard.
- Firmware downloads the active screen into PSRAM when the server's display version
  changes (`GET /api/device/display`).

### Changed

- **Calmer readings** on the OLED and the dashboard: smoothed distance in 0.1 m steps with
  hysteresis, motion label held for 2 s, no constant sweep animation.
- **Dashboard redesign:** quieter graphite theme, self-hosted Inter and JetBrains Mono,
  tabs, two-column desktop layout, range rail instead of the sonar animation.
- Firmware enables the board's 8 MB PSRAM (N16R8).

## [0.1.0] - 2026-10-14

First public release.

### Added

- **Firmware (ESP32-S3):** LD2410C presence/range readout with automatic pin and baud
  detection, authenticated reports to the server, power-button pulse through an
  optocoupler with replay protection (last command id kept in NVS), optional 0.96"
  SSD1306/SH1106 OLED with a mini sonar, range, motion and PC state.
- **Server:** FastAPI backend with separate dashboard (8000) and device (8001) ports,
  argon2 password login, JWT in an httpOnly cookie with CSRF header, host allow-list,
  rate limiting, SQLite history, opt-in automatic wake/sleep.
- **Dashboard:** live sonar view, wake / sleep / shut down controls, 24 h activity
  timeline; installable to the phone home screen.
- **pc-agent:** HMAC-signed sleep/shutdown and heartbeat; packaged as a standalone
  `radarwake-agent.exe` that runs at boot as SYSTEM.
- **Installers:** one-line server installer for Linux/WSL2, Windows-side WSL2 setup
  script, one-line agent installer and uninstaller.
- Prebuilt multi-arch container image on GHCR (amd64, arm64).

[0.2.1]: https://github.com/AkoSuminoe/radarwake/releases/tag/v0.2.1
[0.2.0]: https://github.com/AkoSuminoe/radarwake/releases/tag/v0.2.0
[0.1.0]: https://github.com/AkoSuminoe/radarwake/releases/tag/v0.1.0
