# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/AkoSuminoe/radarwake/releases/tag/v0.1.0
