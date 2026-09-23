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
  <rect width="1024" height="1024" rx="230" fill="#10141a"/>
  <rect x="24" y="24" width="976" height="976" rx="212" fill="none" stroke="#232a34" stroke-width="8"/>
  <g stroke-linecap="round" fill="none" stroke-width="46">
    <path d="M 220 300 h 190" stroke="#4c8dff"/>
    <path d="M 220 400 h 340" stroke="#4c8dff" opacity="0.55"/>
    <path d="M 220 500 h 250" stroke="#4c8dff" opacity="0.35"/>
    <path d="M 520 240 l 260 544" stroke="#3fb950"/>
    <path d="M 640 240 l 160 336" stroke="#f0883a"/>
    <path d="M 760 240 l 70 148" stroke="#b695f8"/>
  </g>
  <circle cx="520" cy="240" r="34" fill="#e6edf3"/>
  <circle cx="780" cy="784" r="26" fill="#3fb950"/>
</svg>
EOF
if qlmanage -t -s 1024 build/icon.svg -o build/ >/dev/null 2>&1 && [ -f build/icon.svg.png ]; then
  cp build/icon.svg.png "$ICONSET/icon_512x512.png"
  for size in 16 32 64 128 256 512; do
    sips -z $size $size "$ICONSET/icon_512x512.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  done
  cp "$ICONSET/icon_512x512.png" "$ICONSET/icon_256x256@2x.png" 2>/dev/null || true
  cp "$ICONSET/icon_512x512.png" "$ICONSET/icon_512x512@2x.png" 2>/dev/null || true
  cp "$ICONSET/icon_16x16.png" "$ICONSET/icon_16x16@2x.png" 2>/dev/null || true
  cp "$ICONSET/icon_32x32.png" "$ICONSET/icon_32x32@2x.png" 2>/dev/null || true
  cp "$ICONSET/icon_128x128.png" "$ICONSET/icon_128x128@2x.png" 2>/dev/null || true
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
