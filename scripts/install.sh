#!/usr/bin/env bash
set -euo pipefail

REPO="odefun/ode"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
BIN_NAME="ode"

OS="$(uname -s)"
ARCH="$(uname -m)"

ASSET=""
APP_ASSET=""
if [ "$OS" = "Darwin" ]; then
  if [ "$ARCH" = "arm64" ]; then
    ASSET="ode-darwin-arm64"
    APP_ASSET="ode-darwin-arm64.zip"
  elif [ "$ARCH" = "x86_64" ]; then
    ASSET="ode-darwin-x64"
    APP_ASSET="ode-darwin-x64.zip"
  fi
elif [ "$OS" = "Linux" ]; then
  if [ "$ARCH" = "x86_64" ] || [ "$ARCH" = "amd64" ]; then
    ASSET="ode-linux-x64"
  fi
fi

if [ -z "$ASSET" ]; then
  echo "Unsupported platform: $OS $ARCH" >&2
  exit 1
fi

URL="https://github.com/$REPO/releases/latest/download/$ASSET"
TMP_DIR="$(mktemp -d)"
TMP_FILE="$TMP_DIR/$ASSET"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$INSTALL_DIR"

if [ "$OS" = "Darwin" ]; then
  URL="https://github.com/$REPO/releases/latest/download/$APP_ASSET"
  TMP_FILE="$TMP_DIR/$APP_ASSET"
  echo "Downloading $URL"
  curl -fsSL "$URL" -o "$TMP_FILE"
  curl -fsSL "https://github.com/$REPO/releases/latest/download/SHA256SUMS" -o "$TMP_DIR/SHA256SUMS"
  expected="$(awk -v asset="$APP_ASSET" '$2 == asset || $2 == "*" asset { print $1 }' "$TMP_DIR/SHA256SUMS")"
  actual="$(shasum -a 256 "$TMP_FILE" | awk '{ print $1 }')"
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "Checksum verification failed for $APP_ASSET" >&2
    exit 1
  fi
  /usr/bin/ditto -x -k "$TMP_FILE" "$TMP_DIR/extracted"
  APP_INSTALL_DIR="${ODE_APP_INSTALL_DIR:-$HOME/Applications}"
  APP_PATH="$APP_INSTALL_DIR/Ode.app"
  SOURCE_APP="$TMP_DIR/extracted/Ode.app"
  STAGED_APP="$APP_INSTALL_DIR/.Ode.app.installing-$$"
  BACKUP_APP="$APP_INSTALL_DIR/.Ode.app.backup-$$"
  codesign --verify --deep --strict "$SOURCE_APP"
  mkdir -p "$APP_INSTALL_DIR"
  rm -rf "$STAGED_APP" "$BACKUP_APP"
  /usr/bin/ditto "$SOURCE_APP" "$STAGED_APP"
  codesign --verify --deep --strict "$STAGED_APP"
  HAD_PREVIOUS=0
  if [ -e "$APP_PATH" ]; then
    mv "$APP_PATH" "$BACKUP_APP"
    HAD_PREVIOUS=1
  fi
  if ! mv "$STAGED_APP" "$APP_PATH"; then
    if [ "$HAD_PREVIOUS" -eq 1 ]; then
      mv "$BACKUP_APP" "$APP_PATH"
    fi
    exit 1
  fi
  if ! ln -sfn "$APP_PATH/Contents/Resources/ode" "$INSTALL_DIR/$BIN_NAME"; then
    rm -rf "$APP_PATH"
    if [ "$HAD_PREVIOUS" -eq 1 ]; then
      mv "$BACKUP_APP" "$APP_PATH"
    fi
    exit 1
  fi
  rm -rf "$BACKUP_APP"
  echo "Installed Ode.app to $APP_PATH"
else
  echo "Downloading $URL"
  curl -fsSL "$URL" -o "$TMP_FILE"
  chmod +x "$TMP_FILE"
  mv "$TMP_FILE" "$INSTALL_DIR/$BIN_NAME"
  chmod +x "$INSTALL_DIR/$BIN_NAME"
fi

echo "Installed ode to $INSTALL_DIR/$BIN_NAME"
if ! command -v ode >/dev/null 2>&1; then
  echo "Add $INSTALL_DIR to your PATH to use the ode command."
fi
