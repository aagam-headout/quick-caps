# quick-caps-core

The rendered-DOM distillation engine behind
[`quick-caps-cli`](https://www.npmjs.com/package/quick-caps-cli) — `PageIR`,
region/action distillation, design-token extraction, and single-file/zip
capture bundling. Host-agnostic: no DOM/browser dependency of its own,
consumed by a `PageDriver` implementation (Playwright, a static fetcher,
or a browser extension).

Most people using this project want `quick-caps-cli`, not this package
directly. See its README for the actual command reference and usage.
