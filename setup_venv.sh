#!/usr/bin/env bash
set -e
VENV_DIR="$(dirname "$0")/.venv"
if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[setup_venv] Creating venv at $VENV_DIR..."
  python3 -m venv "$VENV_DIR"
fi
echo "[setup_venv] Installing packages..."
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install pyrogram tgcrypto py-tgcalls
echo "[setup_venv] Done."
