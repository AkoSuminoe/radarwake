#!/usr/bin/env bash
# radarwake server installer (Linux / WSL2 with Docker).
#
#   curl -fsSL https://raw.githubusercontent.com/AkoSuminoe/radarwake/main/scripts/install.sh | bash
#
# - Clones (or updates) the repo into $RADARWAKE_DIR (default: ~/radarwake)
# - First run: asks for the LAN IP, workstation IP and dashboard password, generates
#   all secrets and writes .env + backend/.env (chmod 600)
# - Pulls the prebuilt image (falls back to a local build) and starts the container
# - Re-running it updates to the latest version and keeps the existing config
set -euo pipefail

REPO_URL="${RADARWAKE_REPO:-https://github.com/AkoSuminoe/radarwake.git}"
DIR="${RADARWAKE_DIR:-$HOME/radarwake}"
BRANCH="${RADARWAKE_BRANCH:-main}"

if [ -t 1 ]; then
  B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'
else
  B=""; G=""; Y=""; R=""; C=""; N=""
fi
info() { printf '%s==>%s %s\n' "$C" "$N" "$*"; }
ok()   { printf '%s[ok]%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s[!]%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '%s[x]%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# curl | bash: stdin is the script, so prompts read from the terminal
TTY=/dev/tty
ask() {  # ask <var> <prompt> [default]
  local __v __p="$2" __d="${3:-}"
  [ -n "$__d" ] && __p="$__p [$__d]"
  read -r -p "$__p: " __v <"$TTY" || true
  printf -v "$1" '%s' "${__v:-$__d}"
}
ask_secret() {  # ask_secret <var> <prompt>
  local __v
  read -r -s -p "$2: " __v <"$TTY" || true
  echo >"$TTY"
  printf -v "$1" '%s' "$__v"
}
rand() { head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | head -c "${1:-43}"; }

cat <<EOF
${B}
  r a d a r w a k e
${N}  presence-aware PC control - server installer

EOF

# --- requirements ---
command -v git >/dev/null || die "git is required (sudo apt install git)"
command -v docker >/dev/null || die "Docker is required: https://docs.docker.com/engine/install/  (or: curl -fsSL https://get.docker.com | sh)"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose ...)"
docker info >/dev/null 2>&1 || die "Cannot talk to Docker. Is it running? Is $USER in the docker group? (sudo usermod -aG docker \$USER, then log in again)"
ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"

IS_WSL=0
grep -qi microsoft /proc/version 2>/dev/null && IS_WSL=1

# --- repo ---
if [ -d "$DIR/.git" ]; then
  info "Updating $DIR"
  git -C "$DIR" fetch --quiet origin "$BRANCH"
  git -C "$DIR" checkout --quiet "$BRANCH"
  git -C "$DIR" reset --quiet --hard "origin/$BRANCH"   # .env files are untracked and stay
else
  info "Cloning into $DIR"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$DIR"
fi
cd "$DIR"
ok "version $(git describe --tags --always 2>/dev/null)"

# --- image ---
# Same name as docker-compose.yml; compose itself needs the .env files, so the image
# is fetched with plain docker first.
IMAGE="${RADARWAKE_IMAGE:-ghcr.io/akosuminoe/radarwake:latest}"
export RADARWAKE_IMAGE="$IMAGE"
info "Fetching the container image"
if docker pull --quiet "$IMAGE" >/dev/null 2>&1; then
  ok "prebuilt image pulled ($IMAGE)"
else
  warn "no prebuilt image for this platform, building locally (a few minutes)"
  docker build -f backend/Dockerfile -t "$IMAGE" .
fi

# --- config (first run only) ---
if [ -f backend/.env ] && [ -f .env ]; then
  ok "existing config kept (backend/.env, .env)"
else
  [ -r "$TTY" ] || die "no terminal for prompts; run the script from an interactive shell"

  guess_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src"){print $(i+1); exit}}')"
  echo
  echo "${B}Network${N}"
  [ "$IS_WSL" = 1 ] && echo "  WSL2: use the Windows host's Wi-Fi/Ethernet IPv4 (ipconfig), with networkingMode=mirrored."
  ask LAN_IP "  Server LAN IP (dashboard + ESP32 endpoint)" "$guess_ip"
  [[ "$LAN_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not an IPv4 address: $LAN_IP"
  ask PC_IP "  Workstation LAN IP (the PC to wake/sleep)" ""
  [[ "$PC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not an IPv4 address: $PC_IP"

  echo
  echo "${B}Dashboard login${N}"
  ask ADMIN_USER "  Username" "admin"
  while :; do
    ask_secret PW "  Password (min. 12 characters)"
    if [ "${#PW}" -lt 12 ]; then warn "too short"; continue; fi
    ask_secret PW2 "  Repeat password"
    [ "$PW" = "$PW2" ] && break
    warn "passwords do not match"
  done

  info "Hashing password (argon2)"
  HASH="$(printf '%s' "$PW" | docker run --rm -i --entrypoint python "$IMAGE" -c \
    'import sys; from pwdlib import PasswordHash; print(PasswordHash.recommended().hash(sys.stdin.read()))')"
  unset PW PW2
  [ -n "$HASH" ] || die "password hashing failed"

  ESP32_API_KEY="$(rand 43)"
  PC_AGENT_SECRET="$(rand 43)"

  umask 077
  printf 'LAN_IP=%s\n' "$LAN_IP" > .env
  sed \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=$(rand 64)|" \
    -e "s|^ADMIN_USERNAME=.*|ADMIN_USERNAME=$ADMIN_USER|" \
    -e "s|^ADMIN_PASSWORD_HASH=.*|ADMIN_PASSWORD_HASH='$HASH'|" \
    -e "s|^ALLOWED_HOSTS=.*|ALLOWED_HOSTS=$LAN_IP,localhost,127.0.0.1|" \
    -e "s|^ESP32_API_KEY=.*|ESP32_API_KEY=$ESP32_API_KEY|" \
    -e "s|^PC_AGENT_URL=.*|PC_AGENT_URL=http://$PC_IP:8765|" \
    -e "s|^PC_AGENT_SECRET=.*|PC_AGENT_SECRET=$PC_AGENT_SECRET|" \
    backend/.env.example > backend/.env
  chmod 600 .env backend/.env
  ok "config written (backend/.env, mode 600)"
  NEW_CONFIG=1
fi

# --- start ---
info "Starting radarwake"
docker compose up -d --no-build backend
LAN_IP="$(sed -n 's/^LAN_IP=//p' .env)"

printf 'Waiting for the health check'
healthy=0
for _ in $(seq 1 30); do
  if curl -fsS -m 2 "http://$LAN_IP:8000/api/health" >/dev/null 2>&1; then healthy=1; break; fi
  printf '.'; sleep 1
done
echo
if [ "$healthy" = 1 ]; then ok "backend is healthy"; else warn "no answer on http://$LAN_IP:8000 yet - check: docker compose logs backend"; fi
echo

cat <<EOF
${B}Dashboard${N}   http://$LAN_IP:8000   (home network only)
${B}ESP32 URL${N}   http://$LAN_IP:8001   -> firmware/src/config.h BACKEND_URL
${B}Config${N}      $DIR/backend/.env
${B}Logs${N}        cd $DIR && docker compose logs -f
${B}Update${N}      re-run this installer
EOF

if [ "${NEW_CONFIG:-0}" = 1 ]; then
  cat <<EOF

${B}Secrets for the other devices${N} (also stored in backend/.env):
  ESP32  API_KEY     = $ESP32_API_KEY
  Agent  secret      = $PC_AGENT_SECRET

${B}Workstation${N} (elevated PowerShell):
  irm https://github.com/AkoSuminoe/radarwake/releases/latest/download/get-agent.ps1 | iex
EOF
fi

if [ "$IS_WSL" = 1 ]; then
  cat <<EOF

${Y}WSL2:${N} the LAN can only reach the container after the Windows-side setup
(mirrored networking + firewall). In an elevated PowerShell on Windows:
  irm https://github.com/AkoSuminoe/radarwake/releases/latest/download/wsl-server-setup.ps1 | iex
EOF
fi
