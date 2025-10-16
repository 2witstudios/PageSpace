#!/bin/bash
# Generate multi-resolution macOS .icns from padded 1024px PNG
# Note: Use the "Icon Exports Padded" folder which already has proper 85% padding

set -e

SOURCE_PNG="../web/public/Icon Exports Padded/Icon-iOS-Default-1024x1024@1x.png"
ICONSET_DIR="PageSpace.iconset"
OUTPUT_ICNS="assets/icon.icns"

echo "🎨 Generating macOS icon from padded source..."
echo "📁 Source: $SOURCE_PNG"

# Create iconset directory
rm -rf "$ICONSET_DIR"
mkdir "$ICONSET_DIR"

# Generate all required macOS icon sizes
echo "📐 Generating all macOS icon sizes..."

sips -z 16 16 "$SOURCE_PNG" --out "$ICONSET_DIR/icon_16x16.png" > /dev/null
sips -z 32 32 "$SOURCE_PNG" --out "$ICONSET_DIR/icon_16x16@2x.png" > /dev/null
sips -z 32 32 "$SOURCE_PNG" --out "$ICONSET_DIR/icon_32x32.png" > /dev/null
sips -z 64 64 "$SOURCE_PNG" --out "$ICONSET_DIR/icon_32x32@2x.png" > /dev/null
sips -z 128 128 "$SOURCE_PNG" --out "$ICONSET_DIR/icon_128x128.png" > /dev/null
sips -z 256 256 "$SOURCE_PNG" --out "$ICONSET_DIR/icon_128x128@2x.png" > /dev/null
sips -z 256 256 "$SOURCE_PNG" --out "$ICONSET_DIR/icon_256x256.png" > /dev/null
sips -z 512 512 "$SOURCE_PNG" --out "$ICONSET_DIR/icon_256x256@2x.png" > /dev/null
sips -z 512 512 "$SOURCE_PNG" --out "$ICONSET_DIR/icon_512x512.png" > /dev/null
sips -z 1024 1024 "$SOURCE_PNG" --out "$ICONSET_DIR/icon_512x512@2x.png" > /dev/null

echo "✅ Generated all icon sizes"

# Convert to .icns
echo "🔨 Creating .icns file..."
iconutil -c icns "$ICONSET_DIR" -o "$OUTPUT_ICNS"

# Update icon.png with the padded version for consistency
cp "$SOURCE_PNG" "assets/icon.png"
echo "✅ Updated assets/icon.png"

# Clean up
rm -rf "$ICONSET_DIR"

echo "✨ Done! Created $OUTPUT_ICNS with all required sizes"
echo ""
echo "Icon sizes included:"
iconutil -c iconset "$OUTPUT_ICNS" -o temp.iconset
ls -lh temp.iconset/
rm -rf temp.iconset
