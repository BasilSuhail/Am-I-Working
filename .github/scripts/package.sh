#!/usr/bin/env bash
# Build dist/am-i-working-<version>.zip: only what a user needs, no tests, design samples or screenshots.
set -euo pipefail
v="${1:?usage: package.sh v1.2.3}"
name="am-i-working-$v"
rm -rf dist && mkdir -p "dist/$name"
cp -R app start-mac.command start-windows.bat README.md "dist/$name/"
echo "$v" > "dist/$name/VERSION"
chmod +x "dist/$name/start-mac.command"
(cd dist && zip -qr "$name.zip" "$name")
echo "Built dist/$name.zip"
