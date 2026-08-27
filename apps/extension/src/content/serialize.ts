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

export async function serializePage(
  settings: CaptureSettings,
  timeoutMs = 45_000,
): Promise<SerializedPage> {
  ensureInit();

  // Settle layout and fonts before SingleFile reads the DOM.
  void document.documentElement.offsetHeight;
  try {
    await document.fonts?.ready;
  } catch {
    /* font loading is best-effort */
  }
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

  const timeout = new Promise<never>((_resolve, reject) =>
    setTimeout(
      () =>
        reject(new Error(`page serialization timed out after ${timeoutMs}ms`)),
      timeoutMs,
    ),
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
      loadDeferredImages: settings.scrollToLoadLazy,
      loadDeferredImagesMaxIdleTime: settings.scrollToLoadLazy ? 1500 : 0,
      // The reason a capture of a busy page was 42 MB.
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
    }),
    timeout,
  ])) as { content: string; title?: string };

  return { html: data.content, title: data.title ?? document.title };
}
