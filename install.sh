#!/bin/bash
set -e

TARBALL_URL="https://github.com/slavamirniy/whtyce/releases/download/v1.1.0/whtyce-1.1.0.tgz"

echo ""
echo "  ========================================="
echo "  whtyce installer"
echo "  ========================================="
echo ""

# --- Detect package manager ---
install_pkg() {
  if command -v apt-get &>/dev/null; then
    apt-get update -qq && apt-get install -y -qq "$@"
  elif command -v yum &>/dev/null; then
    yum install -y "$@"
  elif command -v apk &>/dev/null; then
    apk add --no-cache "$@"
  elif command -v brew &>/dev/null; then
    brew install "$@"
  else
    echo "[error] No supported package manager found (apt/yum/apk/brew)"
    exit 1
  fi
}

maybe_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

install_if_missing() {
  local cmd="$1"
  shift
  if command -v "$cmd" &>/dev/null; then
    echo "  [ok] $cmd"
  else
    echo "  [install] $cmd..."
    maybe_sudo install_pkg "$@"
  fi
}

# Export for maybe_sudo
export -f install_pkg

# --- Git ---
echo "[1/4] Checking git..."
install_if_missing git git

# --- Node.js + npm ---
echo "[2/4] Checking Node.js..."
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 18 ] 2>/dev/null; then
    echo "  [ok] node $(node -v)"
  else
    echo "  [warn] Node.js $(node -v) is too old (need >= 18)"
    echo "  Installing Node.js 20..."
    NEED_NODE=1
  fi
else
  echo "  [install] Node.js not found"
  NEED_NODE=1
fi

if [ "${NEED_NODE:-0}" = "1" ]; then
  if command -v apt-get &>/dev/null; then
    # Use NodeSource for Debian/Ubuntu
    echo "  Installing Node.js 20 via NodeSource..."
    maybe_sudo bash -c 'apt-get update -qq && apt-get install -y -qq ca-certificates curl gnupg'
    maybe_sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | maybe_sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | maybe_sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
    maybe_sudo apt-get update -qq
    maybe_sudo apt-get install -y -qq nodejs
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | maybe_sudo bash -
    maybe_sudo yum install -y nodejs
  elif command -v apk &>/dev/null; then
    maybe_sudo apk add --no-cache nodejs npm
  elif command -v brew &>/dev/null; then
    brew install node@20
  else
    echo "[error] Cannot auto-install Node.js. Install Node.js >= 18 manually."
    exit 1
  fi
  echo "  [ok] node $(node -v)"
fi

if ! command -v npm &>/dev/null; then
  echo "  [install] npm not found, installing..."
  if command -v apt-get &>/dev/null; then
    maybe_sudo apt-get install -y -qq npm
  elif command -v apk &>/dev/null; then
    maybe_sudo apk add --no-cache npm
  fi
fi
echo "  [ok] npm $(npm -v)"

# --- System deps (cmake, tmux, ffmpeg, build tools) ---
echo "[3/4] Checking system dependencies..."
DEPS_NEEDED=""
for cmd in cmake make gcc tmux ffmpeg; do
  if command -v "$cmd" &>/dev/null; then
    echo "  [ok] $cmd"
  else
    echo "  [missing] $cmd"
    case "$cmd" in
      make|gcc) DEPS_NEEDED="$DEPS_NEEDED build-essential" ;;
      *) DEPS_NEEDED="$DEPS_NEEDED $cmd" ;;
    esac
  fi
done

# Deduplicate
DEPS_NEEDED=$(echo "$DEPS_NEEDED" | tr ' ' '\n' | sort -u | tr '\n' ' ' | xargs)

if [ -n "$DEPS_NEEDED" ]; then
  echo "  Installing: $DEPS_NEEDED..."
  if command -v apt-get &>/dev/null; then
    maybe_sudo apt-get update -qq
    maybe_sudo apt-get install -y -qq $DEPS_NEEDED
  elif command -v apk &>/dev/null; then
    DEPS_NEEDED=$(echo "$DEPS_NEEDED" | sed 's/build-essential/build-base/g')
    maybe_sudo apk add --no-cache $DEPS_NEEDED
  elif command -v yum &>/dev/null; then
    DEPS_NEEDED=$(echo "$DEPS_NEEDED" | sed 's/build-essential/gcc gcc-c++ make/g')
    maybe_sudo yum install -y $DEPS_NEEDED
  elif command -v brew &>/dev/null; then
    brew install $DEPS_NEEDED
  fi
fi

# --- Install whtyce ---
echo "[4/4] Installing whtyce..."
maybe_sudo npm install -g "$TARBALL_URL" 2>&1 | tail -5

echo ""
echo "  ========================================="
echo "  whtyce installed!"
echo "  ========================================="
echo ""
echo "  Run:  whtyce"
echo "  Stop: whtyce stop"
echo "  Logs: whtyce logs"
echo ""

# --- Start ---
whtyce
