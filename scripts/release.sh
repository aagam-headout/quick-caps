#!/usr/bin/env bash
set -euo pipefail

version=$(node -p "require('./apps/extension/package.json').version")
output="release/quick-caps-${version}.zip"

rm -rf apps/extension/dist release
mkdir -p release

pnpm install --frozen-lockfile
pnpm -w format:check
pnpm -w lint
# Must run before typecheck: quick-caps-core's exports.types points at
# ./dist/index.d.ts, which does not exist on a fresh checkout.
pnpm -w build:packages
pnpm -w typecheck
pnpm -w test
pnpm -w build
# Reads dist/, so it has to follow the build.
pnpm exec vitest run apps/extension/tests/collector-bundle.test.ts apps/extension/tests/build-artifacts.test.ts

cd apps/extension/dist
zip -r "../../../${output}" . -x '*.map'
cd -

echo "built ${output}"
