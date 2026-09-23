#!/bin/bash
# Package Trace Review as a self-contained macOS .app and .dmg.
#
# Pipeline: tsc+vite build → esbuild single CJS bundle → Node SEA
# (single-executable, no Node required at runtime) → Trace Review.app → DMG.
#
# Usage: bash scripts/package-macos.sh
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
ARCH=$(uname -m)
OUT_DIR="dist-packages"
APP_NAME="Trace Review"
DMG="$OUT_DIR/Trace-Review-$VERSION-$ARCH.dmg"

echo "▶ Packaging Trace Review $VERSION ($ARCH)"

# ── 0. Clean ──────────────────────────────────────────────────────────────
rm -rf build/sea build/bundle build/app build/dmg-root "$OUT_DIR"
mkdir -p build/sea build/bundle build/app "build/dmg-root" "$OUT_DIR"

# ── 1. Build server + web bundle ──────────────────────────────────────────
echo "▶ [1/6] npm run build"
npm run build >/dev/null

# ── 2. Single-file CJS bundle ─────────────────────────────────────────────
echo "▶ [2/6] esbuild bundle"
npx esbuild src/cli.ts \
  --bundle --platform=node --format=cjs --target=node20 \
  --outfile=build/bundle/trace-review.cjs

# ── 3. Node SEA (single executable application) ───────────────────────────
# Base binary: the official nodejs.org build (Homebrew builds are known to
# behave inconsistently with postject injection). Cached under build/node-dist.
echo "▶ [3/6] Node SEA binary"
NODE_VER=$(node -p "process.version.slice(1)")
NODE_DIST_TGZ="build/node-dist/node-v$NODE_VER-darwin-arm64.tar.gz"
if [ ! -f "$NODE_DIST_TGZ" ]; then
  mkdir -p build/node-dist
  curl -sL -o "$NODE_DIST_TGZ" "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-darwin-arm64.tar.gz"
fi
tar xzf "$NODE_DIST_TGZ" -C build/node-dist
SEA_BASE="build/node-dist/node-v$NODE_VER-darwin-arm64/bin/node"

cat > build/sea/sea-config.json <<EOF
{
  "main": "build/bundle/trace-review.cjs",
  "output": "build/sea/sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": false
}
EOF
"$SEA_BASE" --experimental-sea-config build/sea/sea-config.json
cp "$SEA_BASE" "build/sea/trace-review"
chmod u+w build/sea/trace-review
# Best-effort attr cleanup — com.apple.provenance on arm64 is protected (EPERM).
xattr -cr build/sea/trace-review 2>/dev/null || true
codesign --remove-signature build/sea/trace-review 2>/dev/null || true
# NOTE: --macho-segment-name must be exactly "NODE_SEA" (no leading
# underscores) — that is what node's runtime lookup uses. A "__NODE_SEA"
# segment silently breaks the binary (SIGSEGV at startup).
npx -y postject build/sea/trace-review NODE_SEA_BLOB build/sea/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  --macho-segment-name NODE_SEA
codesign --sign - --force build/sea/trace-review

# ── 4. App icon (best-effort; ships without icon on failure) ──────────────
echo "▶ [4/6] app icon"
ICONSET="build/icon.iconset"
mkdir -p "$ICONSET"
cat > build/icon.svg <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#26304a"/>
      <stop offset="1" stop-color="#0b0e16"/>
    </linearGradient>
    <linearGradient id="stroke" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#5b9dff"/>
      <stop offset="1" stop-color="#2fd4de"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#8ff0e6" stop-opacity="0.85"/>
      <stop offset="1" stop-color="#8ff0e6" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <!-- macOS icon grid: content area 824x824 centered (100px margins),
       corner radius ~22.5% — matches system app icon proportions. -->
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)"/>
  <rect x="109" y="109" width="806" height="806" rx="178" fill="none" stroke="#42506e" stroke-width="5" opacity="0.5"/>
  <path d="M 258 716 C 508 716 470 308 758 308"
        fill="none" stroke="url(#stroke)" stroke-width="62" stroke-linecap="round"/>
  <circle cx="258" cy="716" r="30" fill="#0b0e16" stroke="#5b9dff" stroke-width="19"/>
  <circle cx="742" cy="341" r="26" fill="#2fd4de"/>
  <circle cx="758" cy="308" r="150" fill="url(#glow)" opacity="0.6"/>
  <circle cx="758" cy="308" r="34" fill="#b5f5ec"/>
</svg>
EOF
# Render via headless Chrome: qlmanage fills transparent areas with opaque
# white, which appears as a white frame in the Dock.
if npx tsx scripts/render-icon.ts >/dev/null 2>&1 && [ -f build/icon.svg.png ]; then
  # Generate the full iconset with REAL @2x bitmaps (a 1x image copied into an
  # @2x slot renders blurry on Retina displays).
  for size in 16 32 128 256 512; do
    sips -z $size $size build/icon.svg.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) build/icon.svg.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns -o build/app-icon.icns "$ICONSET" && ICON_OK=1 || ICON_OK=0
else
  echo "  (qlmanage unavailable — shipping without custom icon)"
  ICON_OK=0
fi

# ── 5. Assemble Trace Review.app ──────────────────────────────────────────
echo "▶ [5/6] assembling $APP_NAME.app"
APP="build/app/$APP_NAME.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"
cp build/sea/trace-review "$APP/Contents/MacOS/trace-review"
chmod +x "$APP/Contents/MacOS/trace-review"
cp -R dist/web "$APP/Contents/Resources/app/web"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Trace Review</string>
  <key>CFBundleDisplayName</key><string>Trace Review</string>
  <key>CFBundleIdentifier</key><string>com.picrew.trace-review</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>trace-review</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <!-- Background agent: no Dock icon (a windowless foreground app would
       bounce in the Dock forever). Quit via the button in the web UI. -->
  <key>LSUIElement</key><true/>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
$( [ "$ICON_OK" = "1" ] && { cp build/app-icon.icns "$APP/Contents/Resources/icon.icns"; echo '  <key>CFBundleIconFile</key><string>icon.icns</string>'; } )
</dict>
</plist>
EOF
codesign --sign - --force --deep "$APP"

# ── 6. DMG ────────────────────────────────────────────────────────────────
echo "▶ [6/6] creating DMG"
cp -R "$APP" "build/dmg-root/"
ln -s /Applications "build/dmg-root/Applications"
hdiutil create -volname "Trace Review" -srcfolder build/dmg-root -ov -format UDZO "$DMG" >/dev/null
shasum -a 256 "$DMG" | tee "$DMG.sha256"

echo "✓ Done: $DMG ($(du -h "$DMG" | cut -f1))"
