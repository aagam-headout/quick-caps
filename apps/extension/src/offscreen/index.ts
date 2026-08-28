import { runCapture, type CaptureDeps } from '../lib/capture.js';
import { fetchAssetText } from '@quickcaps/core';
import { stitchFrames } from './stitch.js';
import { handleOffscreenRequest, isOffscreenRequest } from './handler.js';
import type { OffscreenProgress, OffscreenResponse } from '../lib/messages.js';

/**
 * Object URLs are revoked once their download has been handed off; tracking
 * them means a long session cannot accumulate blob references.
 */
const objectUrls = new Set<string>();

function createObjectUrl(bytes: Uint8Array, mimeType: string): string {
  // Blob accepts a Uint8Array at runtime, but the DOM lib types only admit an
  // ArrayBuffer-backed view; slice() gives one without reinterpreting bytes.
  const url = URL.createObjectURL(
    new Blob([bytes.slice().buffer], { type: mimeType }),
  );
  objectUrls.add(url);
  return url;
}

function revokeObjectUrl(url: string): void {
  URL.revokeObjectURL(url);
  objectUrls.delete(url);
}

/**
 * The offscreen document does the two things a service worker cannot: compose
 * images on a canvas, and mint an object URL for the download.
 *
 * It no longer inlines anything. single-file-core does that in the page, so the
 * html arriving here is already self-contained.
 */
function captureDeps(): CaptureDeps {
  return {
    fetchText: (url, options) => fetchAssetText(url, options),
    stitch: (input) => stitchFrames(input),
    createObjectUrl: async (bytes, mimeType) =>
      createObjectUrl(bytes, mimeType),
    onProgress: (progress) => {
      // The offscreen document has no port to the popup; the worker relays.
      const message: OffscreenProgress = {
        type: 'offscreen:progress',
        progress,
      };
      void chrome.runtime.sendMessage(message).catch(() => {
        /* the worker may already be gone; progress is not worth failing over */
      });
    },
  };
}

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender,
    respond: (response: OffscreenResponse) => void,
  ) => {
    if (!isOffscreenRequest(message)) return undefined;

    void handleOffscreenRequest(message, {
      capture: (request) =>
        runCapture(
          {
            ir: request.ir,
            html: request.html,
            settings: request.settings,
            frames: request.frames,
            screenshotGeometry: request.screenshotGeometry,
          },
          captureDeps(),
        ),
      stitch: (request) => stitchFrames(request),
      createObjectUrl,
      revokeObjectUrl,
    }).then(respond, () => {
      // handleOffscreenRequest does not reject, so this is only reachable if
      // respond itself throws on a channel the worker already closed.
    });
    return true; // keep the channel open for the async respond
  },
);
