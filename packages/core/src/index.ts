export type * from './ir.js';
export {
  captureSettingsSchema,
  defaultSettings,
  parseSettings,
  type CaptureSettings,
} from './settings.js';
export type {
  AssetBytes,
  FetchOptions,
  PageDriver,
  Viewport,
} from './driver.js';
export {
  collectFromDocument,
  emptyTally,
  type CollectOptions,
} from './collect.js';
export { buildRegions, type RegionOptions } from './regions.js';
export {
  fetchAssets,
  type FetchAssetsOptions,
  type FetchAssetsResult,
  type FetchedAsset,
} from './assets.js';
export {
  assetPathFor,
  buildSingleFile,
  buildZip,
  captureFilename,
  type BundleInput,
  type BundleOutput,
} from './bundle.js';
export {
  buildTokens,
  normalizeColor,
  normalizeLength,
  tallyComputedStyles,
  type BuildTokensOptions,
  type TokenReport,
} from './tokens.js';
export {
  contrastRatio,
  darkTheme,
  lightTheme,
  relativeLuminance,
  semanticPairs,
  themeToCss,
  type SemanticPair,
  type ThemeTokens,
} from './theme.js';
export { fetchAssetBytes, fetchAssetText } from './http.js';
export { assertFetchableUrl, type UrlPolicyOptions } from './url-policy.js';
export {
  buildPerfReport,
  type BuildPerfReportInput,
  type PerfReport,
  type RawNavigationTiming,
  type RawPaintEntry,
  type RawResourceTiming,
} from './perf.js';
// The extract layer is reachable only through the './extract' subpath, never
// from this barrel — the same rule distill/layout/tokenize already follow.
// content.ts reaches distill for flattenRegions, which transitively pulls
// gpt-tokenizer's BPE table, and anything in this barrel lands in the
// extension's collector bundle. collector-bundle.test.ts enforces the size.
