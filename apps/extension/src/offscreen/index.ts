import { runCapture, type CaptureDeps } from '../lib/capture.js';
import { fetchAssetText } from '../lib/http.js';
import { stitchFrames } from './stitch.js';
import type {
  OffscreenCaptureRequest,
  OffscreenProgress,
  OffscreenRequest,
  OffscreenResponse,
} from '../lib/messages.js';

/**
 * Object URLs are revoked once their download has been handed off; tracking
 * them means a long session cannot accumulate blob references.
 */
const objectUrls = new Set<string>();

function createObjectUrl(bytes: Uint8Array, mimeType: string): string {
  // Blob accepts a Uint8Array at runtime, but the DOM lib types only admit an
  // ArrayBuffer-backed view; slice() gives one without reinterpreting bytes.
  const part = bytes.slice().buffer;
  const url = URL.createObjectURL(new Blob([part], { type: mimeType }));
  objectUrls.add(url);
  return url;
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

async function capture(
  request: OffscreenCaptureRequest,
): Promise<OffscreenResponse> {
  const result = await runCapture(
    {
      ir: request.ir,
      html: request.html,
      settings: request.settings,
      frames: request.frames,
    },
    captureDeps(),
  );
  return {
    ok: true,
    type: 'capture',
    result: {
      filename: result.filename,
      mimeType: result.mimeType,
      byteLength: result.byteLength,
      objectUrl: result.objectUrl,
      warnings: result.warnings,
    },
  };
}

async function handle(message: OffscreenRequest): Promise<OffscreenResponse> {
  switch (message.type) {
    case 'offscreen:capture':
      return capture(message);
    case 'offscreen:stitch': {
      const bytes = await stitchFrames(message.request);
      return { ok: true, type: 'stitch', bytes: [...bytes] };
    }
    case 'offscreen:object-url':
      return {
        ok: true,
        type: 'object-url',
        url: createObjectUrl(new Uint8Array(message.bytes), message.mimeType),
      };
    case 'offscreen:revoke':
      URL.revokeObjectURL(message.url);
      objectUrls.delete(message.url);
      return { ok: true, type: 'revoked' };
  }
}

chrome.runtime.onMessage.addListener(
  (
    message: OffscreenRequest,
    _sender,
    respond: (response: OffscreenResponse) => void,
  ) => {
    if (!message.type?.startsWith('offscreen:')) return undefined;
    void handle(message).then(respond, (error: unknown) => {
      respond({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return true; // keep the channel open for the async respond
  },
);
