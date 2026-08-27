import type { CaptureResult } from '../lib/capture.js';
import type {
  OffscreenCaptureRequest,
  OffscreenRequest,
  OffscreenResponse,
} from '../lib/messages.js';
import type { StitchRequest } from '../background/chrome-driver.js';

export type HandlerDeps = {
  capture: (request: OffscreenCaptureRequest) => Promise<CaptureResult>;
  stitch: (request: StitchRequest) => Promise<Uint8Array>;
  createObjectUrl: (bytes: Uint8Array, mimeType: string) => string;
  revokeObjectUrl: (url: string) => void;
};

/**
 * True when a message is one this document should answer.
 *
 * Guards the property access as well as the value: a non-object message would
 * throw here and take every subsequent message down with it.
 */
export function isOffscreenRequest(
  message: unknown,
): message is OffscreenRequest {
  if (typeof message !== 'object' || message === null) return false;
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' && type.startsWith('offscreen:');
}

/**
 * Answers one offscreen request. Never throws: every failure becomes an
 * `ok: false` response, because the caller's only alternative is to hang.
 */
export async function handleOffscreenRequest(
  message: OffscreenRequest,
  deps: HandlerDeps,
): Promise<OffscreenResponse> {
  try {
    switch (message.type) {
      case 'offscreen:capture': {
        const result = await deps.capture(message);
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
      case 'offscreen:stitch': {
        const bytes = await deps.stitch(message.request);
        return { ok: true, type: 'stitch', bytes: [...bytes] };
      }
      case 'offscreen:object-url':
        return {
          ok: true,
          type: 'object-url',
          url: deps.createObjectUrl(
            new Uint8Array(message.bytes),
            message.mimeType,
          ),
        };
      case 'offscreen:revoke':
        deps.revokeObjectUrl(message.url);
        return { ok: true, type: 'revoked' };
      default:
        // Unreachable while the union is exhaustive, but a future message type
        // must not resolve to undefined and be dereferenced by the client.
        return {
          ok: false,
          error: `unknown offscreen request: ${String(
            (message as { type?: unknown }).type,
          )}`,
        };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
