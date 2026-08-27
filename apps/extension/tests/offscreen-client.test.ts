import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OffscreenClient } from '../src/background/offscreen-client.js';

type Mock = {
  offscreen: {
    hasDocument: ReturnType<typeof vi.fn>;
    createDocument: ReturnType<typeof vi.fn>;
    closeDocument: ReturnType<typeof vi.fn>;
    Reason: Record<string, string>;
  };
  runtime: {
    sendMessage: ReturnType<typeof vi.fn>;
    getURL: (path: string) => string;
  };
};

let chromeMock: Mock;

beforeEach(() => {
  chromeMock = {
    offscreen: {
      hasDocument: vi.fn().mockResolvedValue(false),
      createDocument: vi.fn().mockResolvedValue(undefined),
      closeDocument: vi.fn().mockResolvedValue(undefined),
      // Part of the real API surface: chrome.offscreen.Reason is a runtime
      // enum object, not just a type.
      Reason: { BLOBS: 'BLOBS', DOM_PARSER: 'DOM_PARSER' },
    },
    runtime: {
      sendMessage: vi.fn(),
      getURL: (path: string) => `chrome-extension://id/${path}`,
    },
  };
  (globalThis as unknown as { chrome: Mock }).chrome = chromeMock;
});

const stitchRequest = {
  frames: [{ dataUrl: 'a', offsetY: 0 }],
  width: 1,
  height: 1,
  devicePixelRatio: 1,
};

describe('OffscreenClient', () => {
  it('creates the document once across concurrent calls', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValue({
      ok: true,
      type: 'stitch',
      bytes: [1],
    });
    const client = new OffscreenClient();
    await Promise.all([
      client.stitch(stitchRequest),
      client.stitch(stitchRequest),
    ]);
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1);
  });

  it('does not create a document that already exists', async () => {
    chromeMock.offscreen.hasDocument.mockResolvedValue(true);
    await new OffscreenClient().ensure();
    expect(chromeMock.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('states a justification, which the store requires', async () => {
    await new OffscreenClient().ensure();
    const [options] = chromeMock.offscreen.createDocument.mock.calls[0]!;
    expect((options as { justification: string }).justification).toBeTruthy();
    expect((options as { reasons: string[] }).reasons).toContain('BLOBS');
  });

  it('returns stitched bytes as a Uint8Array', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValue({
      ok: true,
      type: 'stitch',
      bytes: [1, 2, 3],
    });
    await expect(new OffscreenClient().stitch(stitchRequest)).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it('returns the object url it was given', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValue({
      ok: true,
      type: 'object-url',
      url: 'blob:abc',
    });
    await expect(
      new OffscreenClient().toObjectUrl(new Uint8Array([1]), 'text/html'),
    ).resolves.toBe('blob:abc');
  });

  it('throws the offscreen error message on failure', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValue({
      ok: false,
      error: 'canvas exploded',
    });
    await expect(
      new OffscreenClient().toObjectUrl(new Uint8Array([1]), 'text/html'),
    ).rejects.toThrow('canvas exploded');
  });

  it('throws when the offscreen document answers the wrong request type', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValue({
      ok: true,
      type: 'revoked',
    });
    await expect(new OffscreenClient().stitch(stitchRequest)).rejects.toThrow(
      'unexpected offscreen response',
    );
  });

  it('closes the document only if one exists', async () => {
    chromeMock.offscreen.hasDocument.mockResolvedValue(true);
    await new OffscreenClient().close();
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalledTimes(1);
  });

  it('does not attempt to close a document that is not there', async () => {
    await new OffscreenClient().close();
    expect(chromeMock.offscreen.closeDocument).not.toHaveBeenCalled();
  });
});
