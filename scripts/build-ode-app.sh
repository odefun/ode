#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_DIR="$ROOT_DIR/packages/computer/helper"
CLI_ENTITLEMENTS="$ROOT_DIR/packages/computer/ode-cli.entitlements.plist"
OUTPUT_DIR="${1:-$ROOT_DIR/dist}"
ARCH="${ODE_APP_ARCH:-$(uname -m)}"
APP_NAME="Ode.app"
APP_DIR="$OUTPUT_DIR/$APP_NAME"
EXECUTABLE="$APP_DIR/Contents/MacOS/Ode Computer Service"
IDENTITY="${ODE_CODESIGN_IDENTITY:--}"
VERSION="$(sed -n 's/.*\"version\": \"\([^\"]*\)\".*/\1/p' "$ROOT_DIR/package.json" | head -n 1)"

if [[ "$IDENTITY" == "-" ]]; then
  SIGN_TIMESTAMP=(--timestamp=none)
else
  SIGN_TIMESTAMP=(--timestamp)
fi

case "$ARCH" in
  arm64|x86_64) ;;
  *)
    echo "Unsupported helper architecture: $ARCH" >&2
    exit 1
    ;;
esac

swift build \
  --package-path "$SERVICE_DIR" \
  --configuration release \
  --arch "$ARCH"

BUILD_DIR="$(swift build --package-path "$SERVICE_DIR" --configuration release --arch "$ARCH" --show-bin-path)"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp "$SERVICE_DIR/Info.plist" "$APP_DIR/Contents/Info.plist"
cp "$BUILD_DIR/OdeComputerHelper" "$EXECUTABLE"
chmod +x "$EXECUTABLE"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP_DIR/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${ODE_BUILD_NUMBER:-1}" "$APP_DIR/Contents/Info.plist"

ICON_SOURCE="$ROOT_DIR/packages/web-ui/static/ode-small.png"
ICONSET="$OUTPUT_DIR/Ode.iconset"
mkdir -p "$ICONSET"
for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
  size="${spec%% *}"
  name="${spec#* }"
  sips -z "$size" "$size" "$ICON_SOURCE" --out "$ICONSET/$name.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP_DIR/Contents/Resources/Ode.icns"

if [[ -n "${ODE_CLI_BINARY:-}" ]]; then
  cp "$ODE_CLI_BINARY" "$APP_DIR/Contents/Resources/ode"
  chmod +x "$APP_DIR/Contents/Resources/ode"
  codesign --remove-signature "$APP_DIR/Contents/Resources/ode" 2>/dev/null || true
  codesign --sign "$IDENTITY" --identifier fun.ode.cli --force --options runtime \
    --entitlements "$CLI_ENTITLEMENTS" "${SIGN_TIMESTAMP[@]}" "$APP_DIR/Contents/Resources/ode"
fi

AGENT_BROWSER_BINARY="$ROOT_DIR/node_modules/agent-browser/bin/agent-browser-darwin-$ARCH"
if [[ -f "$AGENT_BROWSER_BINARY" ]]; then
  cp "$AGENT_BROWSER_BINARY" "$APP_DIR/Contents/Resources/agent-browser"
  chmod +x "$APP_DIR/Contents/Resources/agent-browser"
  codesign --remove-signature "$APP_DIR/Contents/Resources/agent-browser" 2>/dev/null || true
  codesign --sign "$IDENTITY" --identifier fun.ode.agent-browser --force --options runtime "${SIGN_TIMESTAMP[@]}" "$APP_DIR/Contents/Resources/agent-browser"
fi

codesign --remove-signature "$APP_DIR" 2>/dev/null || true
codesign --sign "$IDENTITY" --force --options runtime "${SIGN_TIMESTAMP[@]}" "$APP_DIR"
codesign --verify --deep --strict --verbose=2 "$APP_DIR"

echo "$APP_DIR"
