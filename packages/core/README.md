# quick-caps-core

The rendered-DOM engine behind
[`quick-caps-cli`](https://www.npmjs.com/package/quick-caps-cli) — `PageIR`,
region/action distillation, design-token extraction, the eight-domain data
extraction layer, and single-file/zip capture bundling. Host-agnostic: no
DOM/browser dependency of its own (no `window`, `document`, or `chrome`
globals), consumed by a `PageDriver` implementation (Playwright, a static
fetcher, or a browser extension).

Most people using this project want `quick-caps-cli`, not this package
directly. See its README for the actual command reference and usage.

## Entry points

| Import                     | Holds                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `quick-caps-core`          | `PageIR` and the shared types, `collectFromDocument`, `buildRegions`, `fetchAssets` |
| `quick-caps-core/distill`  | Region/action distillation and its rendering                                        |
| `quick-caps-core/layout`   | The structural tree: regions, roles, boxes                                          |
| `quick-caps-core/collect`  | `collectFromDocument` and its options                                               |
| `quick-caps-core/extract`  | `extractData`, `EXTRACT_DOMAINS`, and the report types for all eight domains        |
| `quick-caps-core/observe`  | Recording types (network requests, cookie inventory) and the redaction helpers      |
| `quick-caps-core/tokens`   | Design-token extraction from a computed-style tally                                 |
| `quick-caps-core/bundle`   | `buildSingleFile`, `buildZip`, `captureFilename`                                    |
| `quick-caps-core/perf`     | `buildPerfReport` over Navigation/Paint/Resource Timing entries                     |
| `quick-caps-core/http`     | `fetchAssetBytes` / `fetchAssetText`, the URL-policy-checked asset fetchers         |
| `quick-caps-core/settings` | The capture-settings zod schema and its defaults                                    |
| `quick-caps-core/theme`    | The light/dark token palettes and contrast helpers the hosts share                  |
