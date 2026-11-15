#!/bin/sh
# Builds and starts the AirPods head tracking helper (macOS 14+, needs Xcode's swiftc).
#   npm run airpods
# The app lives in tools/airpods-helper/build/ and shows 🎧 in the menu bar; Quit is in its menu.
set -e
cd "$(dirname "$0")"
APP="build/One in Three AirPods.app"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
swiftc -O -swift-version 5 main.swift -o "$APP/Contents/MacOS/OneInThreeAirPods" -framework AppKit -framework CoreMotion -framework Network
# Ad-hoc signature: macOS needs one before it will ask for Motion permission.
codesign --force --sign - "$APP" >/dev/null
pkill -f "OneInThreeAirPods" 2>/dev/null || true
open "$APP"
echo "AirPods helper running (🎧 in the menu bar). It streams head motion to ws://127.0.0.1:8765."
