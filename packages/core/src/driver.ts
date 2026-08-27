export type Viewport = {
  width: number;
  height: number;
  documentWidth: number;
  documentHeight: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
};

export type AssetBytes = {
  url: string;
  bytes: Uint8Array;
  contentType: string | null;
};

export type FetchOptions = {
  timeoutMs: number;
  maxBytes: number;
};

/**
 * Everything the capture pipeline needs from a browser. The extension
 * implements this over chrome.* APIs; other hosts implement it differently.
 * No implementation detail of any host may leak into these signatures.
 */
export interface PageDriver {
  /**
   * Run a self-contained function in the page's context and return its
   * serializable result. The function may not close over anything.
   */
  evaluate<T>(fn: () => T): Promise<T>;
  /** Fetch with host credentials, bypassing page CORS. Rejects on failure. */
  fetchAsset(url: string, options: FetchOptions): Promise<AssetBytes>;
  /** Full-page PNG bytes. How they are produced is the host's problem. */
  screenshotFullPage(): Promise<Uint8Array>;
  scrollTo(x: number, y: number): Promise<void>;
  viewport(): Promise<Viewport>;
}
