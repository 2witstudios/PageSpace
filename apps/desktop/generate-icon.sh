#!/bin/bash
# Generate the multi-resolution macOS .icns for one of this shell's apps.
#
#   ./generate-icon.sh            # PageSpace (default)
#   ./generate-icon.sh coder      # PageSpace Coder
#
# PageSpace's source is the "Icon Exports Padded" export, which already carries
# the required 85% padding. Coder's source is drawn by
# scripts/draw-coder-mark.py, which also emits icon.png, icon.ico and the tray
# icon — sips can resize but cannot draw, and nothing else here can write .ico.
#
# macOS only: sips and iconutil ship with the OS.

set -e

VARIANT="${1:-pagespace}"

case "$VARIANT" in
  pagespace)
    SOURCE_PNG="../web/public/Icon Exports Padded/Icon-iOS-Default-1024x1024@1x.png"
    ASSET_DIR="assets"
    ;;
  coder)
    ASSET_DIR="assets/coder"
    SOURCE_PNG="$ASSET_DIR/icon.png"
    echo "🖊  Drawing the coder mark..."
    python3 scripts/draw-coder-mark.py "$ASSET_DIR"
    ;;
  *)
    echo "Unknown variant: $VARIANT (expected 'pagespace' or 'coder')" >&2
    exit 1
    ;;
esac

ICONSET_DIR="$(mktemp -d)/icon.iconset"
OUTPUT_ICNS="$ASSET_DIR/icon.icns"

echo "🎨 Generating macOS icon for $VARIANT..."
echo "📁 Source: $SOURCE_PNG"

mkdir -p "$ICONSET_DIR"

echo "📐 Generating all macOS icon sizes..."
sips -z 16 16     "$SOURCE_PNG" --out "$ICONSET_DIR/icon_16x16.png" > /dev/null
sips -z 32 32     "$SOURCE_PNG" --out "$ICONSET_DIR/icon_16x16@2x.png" > /dev/null
sips -z 32 32     "$SOURCE_PNG" --out "$ICONSET_DIR/icon_32x32.png" > /dev/null
sips -z 64 64     "$SOURCE_PNG" --out "$ICONSET_DIR/icon_32x32@2x.png" > /dev/null
sips -z 128 128   "$SOURCE_PNG" --out "$ICONSET_DIR/icon_128x128.png" > /dev/null
sips -z 256 256   "$SOURCE_PNG" --out "$ICONSET_DIR/icon_128x128@2x.png" > /dev/null
sips -z 256 256   "$SOURCE_PNG" --out "$ICONSET_DIR/icon_256x256.png" > /dev/null
sips -z 512 512   "$SOURCE_PNG" --out "$ICONSET_DIR/icon_256x256@2x.png" > /dev/null
sips -z 512 512   "$SOURCE_PNG" --out "$ICONSET_DIR/icon_512x512.png" > /dev/null
sips -z 1024 1024 "$SOURCE_PNG" --out "$ICONSET_DIR/icon_512x512@2x.png" > /dev/null

echo "🔨 Creating .icns file..."
iconutil -c icns "$ICONSET_DIR" -o "$OUTPUT_ICNS"

# Keep the Linux PNG in step with the .icns source. Coder's is already written
# by the drawing script, and copying it over itself would be a no-op at best.
if [ "$VARIANT" = "pagespace" ]; then
  cp "$SOURCE_PNG" "$ASSET_DIR/icon.png"
  echo "✅ Updated $ASSET_DIR/icon.png"
fi

rm -rf "$(dirname "$ICONSET_DIR")"

echo "✨ Done! Created $OUTPUT_ICNS"
