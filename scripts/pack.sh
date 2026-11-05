#!/usr/bin/env bash
# Builds build/feedpilot.mcpb with only production dependencies inside.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
rm -rf build/stage
mkdir -p build/stage
cp -R dist manifest.json package.json package-lock.json README.md LICENSE build/stage/
(cd build/stage && npm ci --omit=dev --no-audit --no-fund --silent)
npx mcpb validate build/stage/manifest.json
npx mcpb pack build/stage build/feedpilot.mcpb
