# quickcaps-core

The rendered-DOM distillation engine behind
[`quickcaps-cli`](https://www.npmjs.com/package/quickcaps-cli) — `PageIR`,
region/action distillation, design-token extraction, and single-file/zip
capture bundling. Host-agnostic: no DOM/browser dependency of its own,
consumed by a `PageDriver` implementation (Playwright, a static fetcher,
or a browser extension).

Most people using this project want `quickcaps-cli`, not this package
directly. See its README for the actual command reference and usage.
