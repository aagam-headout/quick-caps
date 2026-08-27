import type {
  AssetBytes,
  FetchOptions,
  PageDriver,
  Viewport,
} from '@page-capture/core';
import { fetchAssetBytes } from '../lib/http.js';

export type StitchRequest = {
  frames: { dataUrl: string; offsetY: number }[];
  width: number;
  height: number;
  devicePixelRatio: number;
};

export type ChromeDriverDeps = {
  fetchImpl?: typeof fetch;
  /** Injected so screenshot geometry is testable without an offscreen canvas. */
  stitch?: (request: StitchRequest) => Promise<Uint8Array>;
  /** Chrome throttles captureVisibleTab to 2/second; 550ms stays under it. */
  frameDelayMs?: number;
  /**
   * Ceiling on stitched frames. A tall page would otherwise spend minutes
   * scrolling and hold every frame as a data url: 125 frames of a long article
   * is roughly 60 MB before the canvas even sees them.
   */
  maxFrames?: number;
};

/** Fallback step when the page reports a zero-height viewport. */
const MIN_STEP_PX = 200;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * PageDriver over Chrome's extension APIs. Every core function already proven
 * against the fake driver runs against this one unchanged — that was the point
 * of putting the interface in first.
 */
export class ChromeDriver implements PageDriver {
  constructor(
    private readonly tabId: number,
    private readonly deps: ChromeDriverDeps = {},
  ) {}

  async evaluate<T>(fn: () => T): Promise<T> {
    const frames = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      world: 'ISOLATED',
      func: fn as () => unknown,
    });
    const first = frames[0];
    if (!first) throw new Error(`no result from tab ${this.tabId}`);
    return first.result as T;
  }

  async fetchAsset(url: string, options: FetchOptions): Promise<AssetBytes> {
    return fetchAssetBytes(url, options, this.deps.fetchImpl);
  }

  async viewport(): Promise<Viewport> {
    return this.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio,
    }));
  }

  async scrollTo(x: number, y: number): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      world: 'ISOLATED',
      func: (px: number, py: number) => {
        window.scrollTo(px, py);
      },
      args: [x, y],
    });
  }

  /**
   * Scrolls the page and captures one frame per viewport height.
   *
   * Separate from stitching because only this half needs chrome.tabs. The
   * frames are data-url strings, so they cross a message boundary to the
   * offscreen document without any binary transfer.
   */
  async captureFrames(): Promise<StitchRequest> {
    const delay = this.deps.frameDelayMs ?? 550;
    const maxFrames = this.deps.maxFrames ?? 40;
    const view = await this.viewport();
    const origin = { x: view.scrollX, y: view.scrollY };
    const frames: StitchRequest['frames'] = [];

    // A zero viewport height would make the loop below never advance, pinning
    // the worker forever. Guaranteeing forward progress matters more than the
    // step being exactly right.
    const step = view.height > 0 ? view.height : MIN_STEP_PX;
    const height = Math.max(view.documentHeight, step);

    try {
      for (
        let offsetY = 0;
        offsetY < height && frames.length < maxFrames;
        offsetY += step
      ) {
        await this.scrollTo(0, offsetY);
        if (delay > 0) await sleep(delay);
        frames.push({
          dataUrl: await chrome.tabs.captureVisibleTab({ format: 'png' }),
          offsetY,
        });
      }
    } finally {
      // The user's scroll position is theirs; restore it even on failure.
      await this.scrollTo(origin.x, origin.y);
    }

    return {
      frames,
      width: view.documentWidth,
      // Report the height actually covered, so the canvas is not sized for
      // content that was never captured once the frame cap applied.
      height: Math.min(height, frames.length * step),
      devicePixelRatio: view.devicePixelRatio,
    };
  }

  async screenshotFullPage(): Promise<Uint8Array> {
    const stitch = this.deps.stitch;
    if (!stitch) throw new Error('no stitch implementation supplied');
    return stitch(await this.captureFrames());
  }
}
