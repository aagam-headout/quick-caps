# Releasing

`quickcaps-core` and `quickcaps-cli` are versioned in lockstep — one
version number for both, bumped together even when only one has changes.
Release is manual; there is no CI publish automation.

1. Decide the new version and set it in both `packages/core/package.json`
   and `packages/cli/package.json`.
2. Build both:
   ```bash
   pnpm --filter quickcaps-core build
   pnpm --filter quickcaps-cli build
   ```
3. Publish core first, then cli — cli's `quickcaps-core` dependency is
   `workspace:*`, and `pnpm publish` (not `npm publish`) rewrites that to
   the real published version automatically at publish time. Using plain
   `npm publish` instead would ship a broken `workspace:*` range.
   ```bash
   pnpm --filter quickcaps-core publish
   pnpm --filter quickcaps-cli publish
   ```
4. Tag the release in git:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
