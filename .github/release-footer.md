
---

### Install

**Server** (Linux or WSL2 with Docker):

```bash
curl -fsSL https://raw.githubusercontent.com/AkoSuminoe/radarwake/main/scripts/install.sh | bash
```

**Server on Windows (WSL2)** - Windows-side networking and firewall, elevated PowerShell:

```powershell
irm https://github.com/AkoSuminoe/radarwake/releases/latest/download/wsl-server-setup.ps1 | iex
```

**Workstation agent** (the PC to wake/sleep), elevated PowerShell:

```powershell
irm https://github.com/AkoSuminoe/radarwake/releases/latest/download/get-agent.ps1 | iex
```

Container image: `ghcr.io/akosuminoe/radarwake` (linux/amd64, linux/arm64).

| Asset | Contents |
|---|---|
| `radarwake-agent-windows.zip` | `radarwake-agent.exe` (no Python needed), `install.ps1`, `uninstall.ps1` |
| `install.sh` | server installer |
| `wsl-server-setup.ps1` | WSL2 mirrored networking, firewall, autostart |
| `get-agent.ps1` | one-line agent installer |
| `SHA256SUMS` | checksums |
