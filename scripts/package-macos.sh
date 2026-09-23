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
      <stop offset="0" stop-color="#1d2432"/>
      <stop offset="1" stop-color="#0b0e15"/>
    </linearGradient>
    <linearGradient id="trace" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#4c8dff"/>
      <stop offset="0.55" stop-color="#39c5cf"/>
      <stop offset="1" stop-color="#7ee787"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="228" fill="url(#bg)"/>
  <rect x="10" y="10" width="1004" height="1004" rx="219" fill="none" stroke="#2c3547" stroke-width="5" opacity="0.9"/>
  <!-- timeline lanes -->
  <g stroke="#28324a" stroke-width="3" opacity="0.6">
    <line x1="170" y1="352" x2="854" y2="352"/>
    <line x1="170" y1="512" x2="854" y2="512"/>
    <line x1="170" y1="672" x2="854" y2="672"/>
  </g>
  <g stroke="#28324a" stroke-width="3" opacity="0.35">
    <line x1="170" y1="272" x2="170" y2="752"/>
    <line x1="512" y1="272" x2="512" y2="752"/>
    <line x1="854" y1="272" x2="854" y2="752"/>
  </g>
  <!-- ascending trace across lanes -->
  <path d="M 170 672 H 320 C 410 672 414 512 504 512 H 560 C 660 512 664 352 764 352 H 854"
        fill="none" stroke="url(#trace)" stroke-width="50"
        stroke-linecap="round" stroke-linejoin="round"/>
  <!-- nodes -->
  <circle cx="170" cy="672" r="38" fill="#0b0e15" stroke="#4c8dff" stroke-width="17"/>
  <circle cx="504" cy="512" r="30" fill="#0b0e15" stroke="#39c5cf" stroke-width="14"/>
  <circle cx="854" cy="352" r="42" fill="#7ee787"/>
  <circle cx="854" cy="352" r="66" fill="none" stroke="#7ee787" stroke-width="7" opacity="0.35"/>
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
