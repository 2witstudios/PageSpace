#!/bin/bash
# Process all Icon Composer exports and add macOS-style padding (85% artwork, 15% padding)

set -e

SOURCE_DIR="apps/web/public/Icon Exports"
OUTPUT_DIR="apps/web/public/Icon Exports Padded"

echo "🎨 Processing all icons with 85% artwork / 15% padding..."
echo ""

# Create output directory
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# Process each PNG file
count=0
for icon in "$SOURCE_DIR"/*.png; do
  if [ -f "$icon" ]; then
    filename=$(basename "$icon")

    # Get original dimensions
    width=$(sips -g pixelWidth "$icon" | tail -1 | awk '{print $2}')
    height=$(sips -g pixelHeight "$icon" | tail -1 | awk '{print $2}')

    # Calculate 85% size (15% padding total, 7.5% on each side)
    new_width=$(echo "$width * 0.85" | bc | awk '{print int($1)}')
    new_height=$(echo "$height * 0.85" | bc | awk '{print int($1)}')

    # Create temporary scaled file
    temp_file="temp_scaled_${filename}"

    # Scale to 85%
    sips -z $new_height $new_width "$icon" --out "$temp_file" > /dev/null

    # Pad back to original size
    sips -p $height $width "$temp_file" > /dev/null

    # Move to output directory
    mv "$temp_file" "$OUTPUT_DIR/$filename"

    count=$((count + 1))
    echo "✅ Processed $filename (${width}x${height} → artwork ${new_width}x${new_height}, padded to ${width}x${height})"
  fi
done

echo ""
echo "✨ Done! Processed $count icons with padding"
echo "📁 Output: $OUTPUT_DIR"
echo ""

# Update desktop app assets
echo "📱 Updating desktop app assets..."

# Copy the 1024px padded icon
cp "$OUTPUT_DIR/Icon-iOS-Default-1024x1024@1x.png" "apps/desktop/assets/icon.png"
echo "✅ Updated apps/desktop/assets/icon.png"

# Regenerate .icns from padded 1024px icon
cd apps/desktop
SOURCE_PNG="../web/public/Icon Exports Padded/Icon-iOS-Default-1024x1024@1x.png"
ICONSET_DIR="PageSpace.iconset"
OUTPUT_ICNS="assets/icon.icns"

echo "🔨 Regenerating icon.icns from padded source..."

rm -rf "$ICONSET_DIR"
mkdir "$ICONSET_DIR"

# Generate all required macOS icon sizes
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

iconutil -c icns "$ICONSET_DIR" -o "$OUTPUT_ICNS"
rm -rf "$ICONSET_DIR"

echo "✅ Regenerated icon.icns"
cd - > /dev/null

echo ""
echo "🎉 All done! All icons now have proper macOS padding"
echo ""
echo "Summary:"
echo "  - Processed icons: $OUTPUT_DIR"
echo "  - Desktop icon.png: apps/desktop/assets/icon.png"
echo "  - Desktop icon.icns: apps/desktop/assets/icon.icns"
