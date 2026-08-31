# Releasing

`quick-caps-core` and `quick-caps-cli` are versioned in lockstep — one
version number for both, bumped together even when only one has changes.
Release is manual; there is no CI publish automation.

## Before the first publish

Only needed once, and only for the very first release of each name.

1. `npm whoami` — confirm you're logged in as the account that should own
   both names. `npm login` if not.
2. Enable 2FA on the npm account, then decide whether publishing will need
   an OTP (`--otp=<code>`) or an automation token. A publish that prompts
   for an OTP halfway through step 3 below leaves `core` published and
   `cli` not, which is recoverable but annoying.
3. Confirm both names are still unclaimed:
   ```bash
   npm view quick-caps-core version   # expect E404
   npm view quick-caps-cli version    # expect E404
   ```
4. Sanity-check what will actually ship, per package:
   ```bash
   cd packages/cli && pnpm pack
   tar -tzf quick-caps-cli-*.tgz      # expect dist/, bin/, README.md, LICENSE
   ```
   In particular check `dependencies.quick-caps-core` in the packed
   `package.json` reads a real version, not `workspace:*`.

Publishing is close to irreversible: a version cannot be republished, and
unpublishing is only possible within 72 hours.

## Each release

1. Decide the new version and set it in both `packages/core/package.json`
   and `packages/cli/package.json`.
2. Run every gate, then build both:
   ```bash
   pnpm typecheck && pnpm lint && pnpm test && pnpm format:check
   pnpm build:packages
   ```
   Each package's `prepublishOnly` rebuilds anyway, so this is about
   catching failures before anything reaches the registry, not about the
   build itself.
3. Publish core first, then cli — cli's `quick-caps-core` dependency is
   `workspace:*`, and `pnpm publish` (not `npm publish`) rewrites that to
   the real published version automatically at publish time. Using plain
   `npm publish` instead would ship a broken `workspace:*` range.
   ```bash
   pnpm --filter quick-caps-core publish
   pnpm --filter quick-caps-cli publish
   ```
4. Verify the published artifact resolves for a real consumer, from a
   directory outside this repo:
   ```bash
   cd "$(mktemp -d)" && npx -y quick-caps-cli@X.Y.Z --help
   ```
   This is the only check that proves the rewritten `quick-caps-core`
   dependency actually installs from the registry.
5. Tag the release in git:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
