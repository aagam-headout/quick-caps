#!/usr/bin/env bash
set -euo pipefail

version=$(node -p "require('./apps/extension/package.json').version")
output="release/quickcaps-${version}.zip"

rm -rf apps/extension/dist release
mkdir -p release

pnpm install --frozen-lockfile
pnpm -w format:check
pnpm -w lint
pnpm -w typecheck
pnpm -w test
pnpm -w build
# Reads dist/, so it has to follow the build.
pnpm exec vitest run apps/extension/tests/collector-bundle.test.ts apps/extension/tests/build-artifacts.test.ts

cd apps/extension/dist
zip -r "../../../${output}" . -x '*.map'
cd -

echo "built ${output}"
