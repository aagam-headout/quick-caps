// @ts-expect-error single-file-core ships no type declarations
import { init as sfInit, getPageData } from 'single-file-core/single-file.js';
import type { CaptureSettings } from '@page-capture/core';
import { FETCH_RESOURCE } from './protocol.js';

/**
 * Whole-page serialization via single-file-core, the engine behind the
 * SingleFile extension.
 *
 * This replaced a hand-rolled inliner that lost webfonts, produced XHTML, and
 * broke when another extension injected an element into the page's head.
 * Self-contained page capture has a long tail — shadow DOM, canvas, srcset,
 * @import chains, deferred images — and this library has absorbed it.
 */

export type ResourceFetchResponse = {
  ok: boolean;
  status?: number;
  /** base64, because a message boundary cannot carry bytes. */
  body?: string;
  headers?: Record<string, string>;
  error?: string;
};

let initialized = false;

/**
 * SingleFile runs in the page, so its own fetches are bound by the page's CORS
 * policy and would fail for most cross-origin assets. Every resource request is
 * proxied through the service worker, which fetches under the extension's host
 * permissions instead.
 */
function ensureInit(): void {
  if (initialized) return;
  sfInit({
    fetch: async (url: string, options?: RequestInit): Promise<Response> => {
      const headers: Record<string, string> = {};
      if (options?.headers instanceof Headers) {
        options.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (options?.headers) {
        Object.assign(headers, options.headers);
      }

      const response = (await chrome.runtime.sendMessage({
        type: FETCH_RESOURCE,
        url,
        headers,
      })) as ResourceFetchResponse | undefined;

      if (!response?.ok || response.body === undefined) {
        throw new Error(response?.error ?? `fetch failed: ${url}`);
      }
      const bytes = Uint8Array.from(atob(response.body), (character) =>
        character.charCodeAt(0),
      );
      return new Response(bytes, {
        status: response.status ?? 200,
        headers: new Headers(response.headers ?? {}),
      });
    },
  });
  initialized = true;
}

export type SerializedPage = { html: string; title: string };

export type SerializeOptions = {
  onProgress?: (progress: { done: number; total: number }) => void;
  timeoutMs?: number;
};

type ProgressEvent = {
  type: string;
  detail?: { max?: number; index?: number };
  RESOURCES_INITIALIZED: string;
  RESOURCE_LOADED: string;
  PAGE_ENDED: string;
};

export async function serializePage(
  settings: CaptureSettings,
  options: SerializeOptions = {},
): Promise<SerializedPage> {
  ensureInit();
  const timeoutMs = options.timeoutMs ?? 120_000;

  // Settle layout and fonts before SingleFile reads the DOM.
  void document.documentElement.offsetHeight;
  try {
    await document.fonts?.ready;
  } catch {
    /* font loading is best-effort */
  }
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

  let done = 0;
  let total = 0;
  const onprogress = (event: ProgressEvent): void => {
    if (event.type === event.RESOURCES_INITIALIZED) {
      total = event.detail?.max ?? 0;
      done = 0;
    } else if (event.type === event.RESOURCE_LOADED) {
      done += 1;
    }
    options.onProgress?.({ done, total });
  };

  const timeout = new Promise<never>((_resolve, reject) =>
    setTimeout(() => {
      // Say how far it got: "timed out" alone gives nobody anything to act on.
      const progress = total > 0 ? ` after ${done} of ${total} resources` : '';
      reject(
        new Error(
          `page serialization stalled${progress} (${timeoutMs / 1000}s limit)`,
        ),
      );
    }, timeoutMs),
  );

  const data = (await Promise.race([
    getPageData({
      // Frames need SingleFile's hooks-frames bootstrap, which the npm build
      // does not carry, so cross-frame walking is skipped.
      removeFrames: true,
      removeImports: false,
      removeScripts: settings.inertSnapshot || !settings.include.scripts,
      blockScripts: settings.inertSnapshot || !settings.include.scripts,
      removeUnusedStyles: false,
      removeHiddenElements: false,
      compressHTML: false,
      // Never let SingleFile wait for deferred images. Pages built on
      // IntersectionObserver frequently never trigger inside its timing window
      // and the whole serialization hangs — this is what made a real capture
      // time out. The worker does its own scroll pass before injecting, so
      // lazy content is already materialized by the time we get here.
      loadDeferredImages: false,
      loadDeferredImagesMaxIdleTime: 0,
      // The reason a capture of a busy page came to 42 MB.
      groupDuplicateImages: true,
      saveOriginalUrls: false,
      blockMixedContent: false,
      blockImages: !settings.include.images,
      blockFonts: !settings.include.fonts,
      blockStylesheets: !settings.include.styles,
      blockVideos: true,
      blockAudios: true,
      insertSingleFileComment: false,
      insertMetaCSP: false,
      backgroundSave: false,
      onprogress,
    }),
    timeout,
  ])) as { content: string; title?: string };

  return { html: data.content, title: data.title ?? document.title };
}
