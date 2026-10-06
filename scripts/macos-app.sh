#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
cargo build --locked
bundle="target/TerminalFlow.app"
mkdir -p "$bundle/Contents/MacOS"
cp target/debug/local-terminal "$bundle/Contents/MacOS/local-terminal.new"
mv "$bundle/Contents/MacOS/local-terminal.new" "$bundle/Contents/MacOS/local-terminal"
mkdir -p "$bundle/Contents/Resources/font-licenses"
cp assets/fonts/*LICENSE.txt assets/fonts/README.md "$bundle/Contents/Resources/font-licenses/"
cp assets/AppIcon.icns "$bundle/Contents/Resources/AppIcon.icns"
cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>TerminalFlow</string>
<key>CFBundleDisplayName</key><string>TerminalFlow</string>
<key>CFBundleIdentifier</key><string>com.local-terminal.app</string>
<key>CFBundleExecutable</key><string>local-terminal</string>
<key>CFBundleIconFile</key><string>AppIcon.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>0.1.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
printf 'Created %s\n' "$bundle"
