import type {
  AssetBytes,
  FetchOptions,
  PageDriver,
  Viewport,
} from 'quickcaps-core';
import { fetchAssetBytes } from 'quickcaps-core';
import {
  applyScroll,
  measureViewport,
  type PageMetrics,
} from './page-metrics.js';

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
  /** Ceiling on how far down the page captureFrames will scroll. */
  maxScrollHeightPx?: number;
  /** Ceiling on any one chrome.* call this driver waits on. */
  stepTimeoutMs?: number;
};

/** Fallback step when the page reports a zero-height viewport. */
const MIN_STEP_PX = 200;

/**
 * Default ceiling on total scroll height for a full-page screenshot. Past
 * this an infinite-scroll feed or similar just keeps growing the capture -
 * cap it rather than scroll (and hold frames in memory) forever.
 */
const DEFAULT_MAX_SCROLL_HEIGHT_PX = 20_000;

/**
 * Extra attempts for one frame. captureVisibleTab is throttled to 2/second and
 * rejects outright past that ("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota
 * exceeded"); one transient rejection should not cost the whole screenshot.
 */
const CAPTURE_RETRIES = 2;

/**
 * Marks the element captureFrames should scroll. viewport() and scrollTo()
 * are each a separate chrome.scripting.executeScript call with no shared JS
 * state, so the element found once by viewport() is tagged with this
 * attribute and re-found by attribute in every later scrollTo() call.
 */
const SCROLL_ROOT_ATTR = 'data-quickcaps-scroll-root';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ceiling on a single chrome.* call.
 *
 * captureVisibleTab and executeScript normally reject when they cannot do
 * their job, but not always: a tab whose window is minimised, occluded, or
 * sitting on a modal dialog can leave the promise pending for good. One of
 * those hung the whole worker, which then refused every later capture with "A
 * capture is already running" until the extension was reloaded.
 */
const DEFAULT_STEP_TIMEOUT_MS = 30_000;

/** Rejects rather than waiting on a chrome.* call that never settles. */
function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  if (timeoutMs <= 0) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} did not respond within ${timeoutMs}ms`)),
      timeoutMs,
    );
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * PageDriver over Chrome's extension APIs. Every core function already proven
 * against the fake driver runs against this one unchanged - that was the point
 * of putting the interface in first.
 */
export class ChromeDriver implements PageDriver {
  constructor(
    private readonly tabId: number,
    private readonly deps: ChromeDriverDeps = {},
  ) {}

  /** Any chrome.* call, bounded - see withTimeout. */
  private step<T>(work: Promise<T>, what: string): Promise<T> {
    return withTimeout(
      work,
      this.deps.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      what,
    );
  }

  async evaluate<T>(fn: () => T): Promise<T> {
    const frames = await this.step(
      chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        world: 'ISOLATED',
        func: fn as () => unknown,
      }),
      'The page',
    );
    const first = frames[0];
    if (!first) throw new Error(`no result from tab ${this.tabId}`);
    return first.result as T;
  }

  async fetchAsset(url: string, options: FetchOptions): Promise<AssetBytes> {
    return fetchAssetBytes(url, options, this.deps.fetchImpl);
  }

  async viewport(): Promise<Viewport> {
    return this.metrics();
  }

  /** viewport() plus the scroll port's size, which only captureFrames needs. */
  private async metrics(): Promise<PageMetrics> {
    const frames = await this.step(
      chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        world: 'ISOLATED',
        func: measureViewport,
        args: [SCROLL_ROOT_ATTR],
      }),
      'Measuring the page',
    );
    const first = frames[0];
    if (!first) throw new Error(`no result from tab ${this.tabId}`);
    const view = first.result as PageMetrics | undefined;
    // An injection that ran but produced nothing (the page navigated
    // mid-measurement) would otherwise surface as a TypeError on a property
    // read three calls later.
    if (!view || typeof view.height !== 'number') {
      throw new Error(
        'Could not measure the page. Reload it and try capturing again.',
      );
    }
    // A NaN or negative dimension poisons every calculation downstream - the
    // scroll loop, the canvas size, the stitch offsets. Normalize here.
    const finite = (value: number, fallback: number): number =>
      Number.isFinite(value) && value > 0 ? value : fallback;
    return {
      ...view,
      width: finite(view.width, 0),
      height: finite(view.height, 0),
      documentWidth: finite(view.documentWidth, finite(view.width, 0)),
      documentHeight: finite(view.documentHeight, finite(view.height, 0)),
      scrollX: Number.isFinite(view.scrollX) ? view.scrollX : 0,
      scrollY: Number.isFinite(view.scrollY) ? view.scrollY : 0,
      devicePixelRatio: finite(view.devicePixelRatio, 1),
      scrollPortWidth: finite(view.scrollPortWidth, finite(view.width, 0)),
      scrollPortHeight: finite(view.scrollPortHeight, finite(view.height, 0)),
    };
  }

  async scrollTo(x: number, y: number): Promise<void> {
    await this.scrollToReached(x, y);
  }

  /**
   * Scrolls and returns where the page actually landed.
   *
   * captureFrames files each frame at the offset the page reached, not the one
   * it asked for: a page that refuses to scroll (or stops short) would
   * otherwise have the same unscrolled frame stitched in at several different
   * offsets, repeating its content down the image.
   */
  private async scrollToReached(
    x: number,
    y: number,
  ): Promise<{ x: number; y: number }> {
    const frames = await this.step(
      chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        world: 'ISOLATED',
        func: applyScroll,
        args: [x, y, SCROLL_ROOT_ATTR],
      }),
      'Scrolling the page',
    );
    const reached = frames[0]?.result as
      { x?: unknown; y?: unknown } | undefined;
    const finite = (value: unknown, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return { x: finite(reached?.x, x), y: finite(reached?.y, y) };
  }

  /**
   * Undoes the tagging viewport() may have left on the page's scroll container.
   *
   * Never throws: it runs in cleanup paths, and the tab having navigated (or
   * closed) is exactly when it fails - reporting that would mask the real
   * error the caller is already handling. The attribute dies with the document
   * either way.
   */
  async clearScrollRootTag(): Promise<void> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        world: 'ISOLATED',
        func: (attr: string) => {
          document.querySelector(`[${attr}]`)?.removeAttribute(attr);
        },
        args: [SCROLL_ROOT_ATTR],
      });
    } catch {
      /* the page is gone; the tag went with it */
    }
  }

  /**
   * The window the tab lives in, so captureVisibleTab targets that window
   * rather than "whichever window is current" - a capture triggered from a
   * popup in another window would otherwise screenshot the wrong page.
   */
  private async captureWindowId(): Promise<number | undefined> {
    try {
      const tab = await this.step(chrome.tabs.get(this.tabId), 'The tab');
      // Only refuse on an explicit false: the field is absent in tests and in
      // some older Chrome builds, and guessing "inactive" there would block a
      // capture that would have worked.
      if (tab?.active === false) {
        throw new Error(
          'Chrome can only screenshot the tab you are looking at. Switch to that tab and try again.',
        );
      }
      return tab?.windowId;
    } catch (error) {
      // The friendly refusal above must reach the user; a failed tabs.get
      // (no such tab, no permission) just means "no window id, use the
      // current one" and the capture below reports its own failure.
      if (error instanceof Error && error.message.startsWith('Chrome can only'))
        throw error;
      return undefined;
    }
  }

  /** One frame, retried past Chrome's per-second captureVisibleTab quota. */
  private async captureFrame(
    windowId: number | undefined,
    backoffMs: number,
  ): Promise<string> {
    let lastError: unknown = new Error('the screenshot could not be taken');
    for (let attempt = 0; attempt <= CAPTURE_RETRIES; attempt++) {
      try {
        const dataUrl = await this.step(
          windowId === undefined
            ? chrome.tabs.captureVisibleTab({ format: 'png' })
            : chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
          'The screenshot',
        );
        if (typeof dataUrl === 'string' && dataUrl.length > 0) return dataUrl;
        lastError = new Error('Chrome returned an empty screenshot frame');
      } catch (error) {
        lastError = error;
      }
      if (backoffMs > 0) await sleep(backoffMs * (attempt + 1));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
    const maxScrollHeightPx =
      this.deps.maxScrollHeightPx ?? DEFAULT_MAX_SCROLL_HEIGHT_PX;
    const view = await this.metrics();
    const origin = { x: view.scrollX, y: view.scrollY };
    const frames: StitchRequest['frames'] = [];

    // A zero viewport height would make the loop below never advance, pinning
    // the worker forever. Guaranteeing forward progress matters more than the
    // step being exactly right.
    const visible = Math.min(
      view.height > 0 ? view.height : MIN_STEP_PX,
      view.scrollPortHeight > 0 ? view.scrollPortHeight : MIN_STEP_PX,
    );
    // Stepping by the window height past a scroll port shorter than the window
    // would skip the content in between.
    const step = visible > 0 ? visible : MIN_STEP_PX;
    const height = Math.min(
      Math.max(view.documentHeight, step),
      maxScrollHeightPx,
    );
    // The page stops scrolling here, so a request past it lands short of what
    // was asked for. Recording the requested offset instead of this one draws
    // the last frame too low: the bottom of every page whose height is not an
    // exact multiple of the viewport came out duplicated and shifted.
    const maxOffsetY = Math.max(0, view.documentHeight - visible);
    const windowId = await this.captureWindowId();

    let lastError: unknown;
    let coveredTo = 0;
    let lastOffsetY = -1;
    try {
      for (
        let requestedY = 0;
        requestedY < height && frames.length < maxFrames;
        requestedY += step
      ) {
        // Where the page actually went, which is not always where it was
        // asked to go - see scrollToReached.
        const reached = await this.scrollToReached(
          0,
          Math.min(requestedY, maxOffsetY),
        );
        const offsetY = reached.y;
        // The page stopped moving: every further frame would be this same
        // picture stitched in lower down.
        if (frames.length > 0 && offsetY <= lastOffsetY) break;
        lastOffsetY = offsetY;
        if (delay > 0) await sleep(delay);
        try {
          frames.push({
            dataUrl: await this.captureFrame(windowId, delay),
            offsetY,
          });
          coveredTo = offsetY + step;
        } catch (error) {
          // One unreadable frame leaves a gap in the image; failing the whole
          // screenshot over it would throw away everything else.
          lastError = error;
        }
      }
    } finally {
      // The user's scroll position is theirs; restore it even on failure, and
      // do not let cleanup trouble replace the error that got us here.
      try {
        await this.scrollTo(origin.x, origin.y);
      } catch {
        /* the page navigated; its scroll position is moot */
      }
      await this.clearScrollRootTag();
    }

    if (frames.length === 0) {
      const detail =
        lastError instanceof Error
          ? lastError.message
          : String(lastError ?? '');
      throw new Error(
        detail
          ? `Could not take the screenshot: ${detail}`
          : 'Could not take the screenshot: Chrome returned no frames.',
      );
    }

    return {
      frames,
      // Every frame is a picture of the window, so the window's width is the
      // width there is. Sizing to the document instead cut the right edge off
      // whenever the scroll root was an inner pane (its scrollWidth excludes
      // the sidebar beside it), and left an empty band on a page wider than
      // the window - captureVisibleTab cannot see past the window either way.
      width: view.width > 0 ? view.width : view.documentWidth,
      // Report the height actually covered, so the canvas is not sized for
      // content that was never captured once the frame cap applied.
      height: Math.min(height, coveredTo),
      devicePixelRatio: view.devicePixelRatio,
    };
  }

  async screenshotFullPage(): Promise<Uint8Array> {
    const stitch = this.deps.stitch;
    if (!stitch) throw new Error('no stitch implementation supplied');
    return stitch(await this.captureFrames());
  }
}
