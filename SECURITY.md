# Security policy

radarwake can power a computer on and off, so security issues are taken seriously.

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's
[private vulnerability reporting](https://github.com/AkoSuminoe/radarwake/security/advisories/new)
instead. Include the affected component (firmware, backend, dashboard, pc-agent,
installers), steps to reproduce and the impact.

You can expect a first reply within a week.

## Scope and design assumptions

- The server is meant to be reachable **only from the home LAN**. Exposing ports 8000/8001
  to the internet is outside the supported setup.
- Traffic on the LAN is plain HTTP inside WPA2/WPA3 Wi-Fi; see "Security decisions" in the
  README for the full threat model.
