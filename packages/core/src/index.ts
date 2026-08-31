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
// Types only, so `PageIR.recording` is nameable by a published consumer at
// zero bundle cost. The caps and the redaction functions are runtime values
// and stay behind the './observe' subpath, where only a host that actually
// records has to pay for them.
export type {
  BodySkipReason,
  CookieJar,
  CookieRecord,
  RecordedBody,
  RecordedRequest,
  Recording,
} from './observe/types.js';
// The extract layer is reachable only through the './extract' subpath, never
// from this barrel — the same rule distill/layout/tokenize already follow.
// Anything in this barrel lands in the extension's collector bundle, and the
// extract layer is far larger than any host needs by default.
// collector-bundle.test.ts enforces the size.
