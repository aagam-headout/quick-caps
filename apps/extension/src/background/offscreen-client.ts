import type { StitchRequest } from './chrome-driver.js';
import type {
  OffscreenCaptureRequest,
  OffscreenCaptureResult,
  OffscreenRequest,
  OffscreenResponse,
} from '../lib/messages.js';

const DOCUMENT_PATH = 'src/offscreen/index.html';

/**
 * Wraps the offscreen document, which exists for the things a service worker
 * cannot do: decode and compose images, and create an object URL.
 *
 * Its lifetime also tends to keep the worker alive during a capture, but that
 * is a side effect and not relied on - session.ts carries the durability story.
 */
export class OffscreenClient {
  private creating: Promise<void> | undefined;

  async ensure(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) return;
    // Concurrent captures must not race two createDocument calls, which Chrome
    // rejects; the in-flight promise is shared.
    this.creating ??= chrome.offscreen.createDocument({
      url: DOCUMENT_PATH,
      reasons: [
        chrome.offscreen.Reason.BLOBS,
        chrome.offscreen.Reason.DOM_PARSER,
      ],
      justification:
        'Compose the full-page screenshot, assemble the archive, and create the download URL.',
    });
    await this.creating;
  }

  private async send(request: OffscreenRequest): Promise<OffscreenResponse> {
    await this.ensure();
    const response = (await chrome.runtime.sendMessage(
      request,
    )) as OffscreenResponse;
    if (!response.ok) throw new Error(response.error);
    return response;
  }

  /** Runs the whole rewrite-and-bundle pipeline where the DOM lives. */
  async capture(
    request: Omit<OffscreenCaptureRequest, 'type'>,
  ): Promise<OffscreenCaptureResult> {
    const response = await this.send({ type: 'offscreen:capture', ...request });
    if (response.ok && response.type === 'capture') return response.result;
    throw new Error('unexpected offscreen response for capture');
  }

  async stitch(request: StitchRequest): Promise<Uint8Array> {
    const response = await this.send({ type: 'offscreen:stitch', request });
    if (response.ok && response.type === 'stitch') {
      return new Uint8Array(response.bytes);
    }
    throw new Error('unexpected offscreen response for stitch');
  }

  async toObjectUrl(bytes: Uint8Array, mimeType: string): Promise<string> {
    const response = await this.send({
      type: 'offscreen:object-url',
      bytes: [...bytes],
      mimeType,
    });
    if (response.ok && response.type === 'object-url') return response.url;
    throw new Error('unexpected offscreen response for object url');
  }

  async revoke(url: string): Promise<void> {
    await this.send({ type: 'offscreen:revoke', url });
  }

  async close(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
    this.creating = undefined;
  }
}
