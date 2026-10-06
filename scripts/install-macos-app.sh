#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
profile="${CARGO_PROFILE:-dev}"
cargo build --locked --profile "$profile"
build_dir="$profile"
if [ "$profile" = dev ]; then build_dir=debug; fi
app_dir="${1:-/Applications}"
bundle="$app_dir/TerminalFlow.app"
mkdir -p "$bundle/Contents/MacOS"
cp "target/$build_dir/local-terminal" "$bundle/Contents/MacOS/local-terminal.new"
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
<key>CFBundleURLTypes</key><array><dict>
<key>CFBundleURLName</key><string>com.local-terminal.app.automation</string>
<key>CFBundleTypeRole</key><string>Shell</string>
<key>CFBundleURLSchemes</key><array><string>terminalflow</string></array>
</dict></array>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
codesign --force --sign - "$bundle"
helper="$app_dir/TerminalFlow Finder.app"
osacompile -o "$helper" scripts/finder-helper.applescript
plutil -replace CFBundleIdentifier -string com.local-terminal.finder "$helper/Contents/Info.plist"
plutil -replace NSAppleEventsUsageDescription -string 'Opens TerminalFlow at the current Finder folder.' "$helper/Contents/Info.plist"
cp assets/AppIcon.icns "$helper/Contents/Resources/applet.icns"
codesign --force --sign - "$helper"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$bundle"
printf 'Installed %s\n' "$bundle" "$helper"
