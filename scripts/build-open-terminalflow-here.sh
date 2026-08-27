#!/bin/zsh

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
	print -u2 "The Finder helper can only be built on macOS."
	exit 1
fi

script_dir="${0:A:h}"
project_dir="${script_dir:h}"
source_file="$script_dir/open-terminalflow-here.applescript"
entitlements_file="$script_dir/open-terminalflow-here-entitlements.plist"
icon_file="$project_dir/build/icon.icns"
output_dir="$project_dir/dist/finder-helper"
app_path="$output_dir/Open TerminalFlow Here.app"
archive_path="$output_dir/Open-TerminalFlow-Here.zip"
build_stamp="$(date +%Y%m%d-%H%M%S)"
version="$(node -p "require('$project_dir/package.json').version")"

mkdir -p "$output_dir"

if [[ -e "$app_path" ]]; then
	mv "$app_path" "$output_dir/Open TerminalFlow Here.app.previous-$build_stamp"
fi

if [[ -e "$archive_path" ]]; then
	mv "$archive_path" "$archive_path.previous-$build_stamp"
fi

osacompile -o "$app_path" "$source_file"
cp "$icon_file" "$app_path/Contents/Resources/TerminalFlow.icns"

plist_path="$app_path/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string com.terminalflow.open-here' "$plist_path"
/usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $version" "$plist_path"
/usr/libexec/PlistBuddy -c 'Add :CFBundleVersion string 1' "$plist_path"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIconFile TerminalFlow.icns' "$plist_path"
/usr/libexec/PlistBuddy -c 'Add :LSUIElement bool true' "$plist_path"
/usr/libexec/PlistBuddy -c 'Set :NSAppleEventsUsageDescription Open the folder shown in Finder as a new TerminalFlow tab.' "$plist_path"

codesign \
	--force \
	--deep \
	--options runtime \
	--entitlements "$entitlements_file" \
	--sign - \
	"$app_path"

codesign --verify --deep --strict --verbose=2 "$app_path"
ditto -c -k --sequesterRsrc --keepParent "$app_path" "$archive_path"

print "Finder helper app: $app_path"
print "Portable archive: $archive_path"
