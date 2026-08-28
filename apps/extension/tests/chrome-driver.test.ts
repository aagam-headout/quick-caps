import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installChromeMock,
  stubViewport,
  type ChromeMock,
} from './chrome-mock.js';
import { ChromeDriver } from '../src/background/chrome-driver.js';

let chromeMock: ChromeMock;

beforeEach(() => {
  chromeMock = installChromeMock();
});

function responseLike(init: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  bytes?: Uint8Array;
}) {
  const headers = new Map(Object.entries(init.headers ?? {}));
  const arrayBuffer = vi.fn(async () => {
    const bytes = init.bytes ?? new Uint8Array();
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
  });
  return {
    response: {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: init.statusText ?? 'OK',
      headers: { get: (name: string) => headers.get(name) ?? null },
      arrayBuffer,
    } as unknown as Response,
    arrayBuffer,
  };
}

describe('ChromeDriver.evaluate', () => {
  it('runs the function in the tab and returns its result', async () => {
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: 42 }]);
    await expect(new ChromeDriver(7).evaluate(() => 42)).resolves.toBe(42);
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7 } }),
    );
  });

  it('throws naming the tab when no frame result comes back', async () => {
    chromeMock.scripting.executeScript.mockResolvedValue([]);
    await expect(new ChromeDriver(7).evaluate(() => 1)).rejects.toThrow(
      'no result from tab 7',
    );
  });
});

describe('ChromeDriver.fetchAsset', () => {
  it('returns bytes and content type', async () => {
    const { response } = responseLike({
      headers: { 'content-type': 'image/png' },
      bytes: new Uint8Array([1, 2, 3]),
    });
    const driver = new ChromeDriver(7, {
      fetchImpl: vi.fn().mockResolvedValue(response),
    });
    const asset = await driver.fetchAsset('https://example.com/a.png', {
      timeoutMs: 100,
      maxBytes: 10,
    });
    expect(asset.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(asset.contentType).toBe('image/png');
  });

  it('rejects on a non-ok response with the status in the message', async () => {
    const { response } = responseLike({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });
    const driver = new ChromeDriver(7, {
      fetchImpl: vi.fn().mockResolvedValue(response),
    });
    await expect(
      driver.fetchAsset('https://example.com/x.png', {
        timeoutMs: 100,
        maxBytes: 10,
      }),
    ).rejects.toThrow('404');
  });

  it('rejects an oversized response without downloading its body', async () => {
    const { response, arrayBuffer } = responseLike({
      headers: { 'content-length': '5000' },
    });
    const driver = new ChromeDriver(7, {
      fetchImpl: vi.fn().mockResolvedValue(response),
    });
    await expect(
      driver.fetchAsset('https://example.com/big.png', {
        timeoutMs: 100,
        maxBytes: 10,
      }),
    ).rejects.toThrow('exceeds');
    // The declared length is enough to refuse: reading the body would defeat
    // the point of having a cap.
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('rejects a response whose actual body exceeds the cap despite no content-length', async () => {
    const { response } = responseLike({ bytes: new Uint8Array(50) });
    const driver = new ChromeDriver(7, {
      fetchImpl: vi.fn().mockResolvedValue(response),
    });
    await expect(
      driver.fetchAsset('https://example.com/lying.png', {
        timeoutMs: 100,
        maxBytes: 10,
      }),
    ).rejects.toThrow('exceeds');
  });

  it('aborts the request when the timeout elapses', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    const driver = new ChromeDriver(7, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      driver.fetchAsset('https://example.com/slow.png', {
        timeoutMs: 10,
        maxBytes: 100,
      }),
    ).rejects.toThrow('aborted');
  });

  it('omits credentials so a capture cannot leak session cookies', async () => {
    const { response } = responseLike({ bytes: new Uint8Array([1]) });
    const fetchImpl = vi.fn().mockResolvedValue(response);
    await new ChromeDriver(7, { fetchImpl }).fetchAsset('https://x.test/a', {
      timeoutMs: 100,
      maxBytes: 10,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://x.test/a',
      expect.objectContaining({ credentials: 'omit' }),
    );
  });
});

describe('ChromeDriver.viewport', () => {
  it('reads dimensions from the page', async () => {
    stubViewport(chromeMock, { documentHeight: 4000, scrollY: 120 });
    await expect(new ChromeDriver(7).viewport()).resolves.toMatchObject({
      documentHeight: 4000,
      scrollY: 120,
    });
  });
});

describe('ChromeDriver.screenshotFullPage', () => {
  it('captures one frame per viewport height and delegates stitching', async () => {
    stubViewport(chromeMock);
    chromeMock.tabs.captureVisibleTab.mockResolvedValue(
      'data:image/png;base64,AAAA',
    );
    const stitch = vi.fn().mockResolvedValue(new Uint8Array([9]));

    const png = await new ChromeDriver(7, {
      stitch,
      frameDelayMs: 0,
    }).screenshotFullPage();

    expect(png).toEqual(new Uint8Array([9]));
    // 1200px document at a 500px viewport is three frames.
    expect(chromeMock.tabs.captureVisibleTab).toHaveBeenCalledTimes(3);
    expect(stitch).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 1000,
        height: 1200,
        frames: [
          { dataUrl: 'data:image/png;base64,AAAA', offsetY: 0 },
          { dataUrl: 'data:image/png;base64,AAAA', offsetY: 500 },
          // The page stops scrolling at documentHeight - viewportHeight, so
          // the third frame shows 700..1200 and must be recorded there.
          // Filing it at the requested 1000 drew it 300px too low and
          // duplicated the middle of the page across the bottom.
          { dataUrl: 'data:image/png;base64,AAAA', offsetY: 700 },
        ],
      }),
    );
  });

  it('restores the original scroll position afterwards', async () => {
    stubViewport(chromeMock, { scrollY: 300, documentHeight: 1000 });
    chromeMock.tabs.captureVisibleTab.mockResolvedValue(
      'data:image/png;base64,A',
    );
    await new ChromeDriver(7, {
      stitch: async () => new Uint8Array([1]),
      frameDelayMs: 0,
    }).screenshotFullPage();

    const scrollArgs = chromeMock.scripting.executeScript.mock.calls
      .map(([arg]) => arg as { args?: unknown[] })
      // scrollTo() calls pass [x, y, scrollRootAttr]; other executeScript
      // calls (viewport's, and the post-capture tag cleanup) don't match.
      .filter((arg) => arg.args?.length === 3)
      .map((arg) => arg.args!.slice(0, 2));
    expect(scrollArgs.at(-1)).toEqual([0, 300]);
  });

  it('restores scroll even when a capture throws', async () => {
    stubViewport(chromeMock, { scrollY: 250, documentHeight: 1000 });
    chromeMock.tabs.captureVisibleTab.mockRejectedValue(new Error('throttled'));
    const driver = new ChromeDriver(7, {
      stitch: async () => new Uint8Array([1]),
      frameDelayMs: 0,
    });
    await expect(driver.screenshotFullPage()).rejects.toThrow('throttled');
    const scrollArgs = chromeMock.scripting.executeScript.mock.calls
      .map(([arg]) => arg as { args?: unknown[] })
      .filter((arg) => arg.args?.length === 3)
      .map((arg) => arg.args!.slice(0, 2));
    expect(scrollArgs.at(-1)).toEqual([0, 250]);
  });

  it('throws a clear error when no stitch implementation was supplied', async () => {
    stubViewport(chromeMock);
    await expect(new ChromeDriver(7).screenshotFullPage()).rejects.toThrow(
      'no stitch implementation',
    );
  });
});

describe('ChromeDriver.captureFrames guards', () => {
  it('terminates when the page reports a zero-height viewport', async () => {
    // Without a minimum step this loop never advances and pins the worker.
    stubViewport(chromeMock, { height: 0, documentHeight: 1000 });
    chromeMock.tabs.captureVisibleTab.mockResolvedValue(
      'data:image/png;base64,A',
    );

    const request = await new ChromeDriver(7, {
      frameDelayMs: 0,
    }).captureFrames();

    expect(request.frames.length).toBeGreaterThan(0);
    expect(request.frames.length).toBeLessThanOrEqual(40);
  });

  it('captures at least one frame when the document is shorter than the viewport', async () => {
    stubViewport(chromeMock, { height: 800, documentHeight: 200 });
    chromeMock.tabs.captureVisibleTab.mockResolvedValue(
      'data:image/png;base64,A',
    );
    const request = await new ChromeDriver(7, {
      frameDelayMs: 0,
    }).captureFrames();
    expect(request.frames).toHaveLength(1);
  });

  it('retries a frame Chrome throttled instead of losing the screenshot', async () => {
    stubViewport(chromeMock, { height: 500, documentHeight: 500 });
    chromeMock.tabs.captureVisibleTab
      .mockRejectedValueOnce(
        new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota exceeded'),
      )
      .mockResolvedValue('data:image/png;base64,A');

    const request = await new ChromeDriver(7, {
      frameDelayMs: 0,
    }).captureFrames();

    expect(request.frames).toHaveLength(1);
  });

  it('keeps the frames it did capture when one of them fails outright', async () => {
    stubViewport(chromeMock, { height: 500, documentHeight: 1500 });
    let call = 0;
    chromeMock.tabs.captureVisibleTab.mockImplementation(async () => {
      call++;
      // Frame two fails every retry; frames one and three succeed.
      if (call >= 2 && call <= 4) throw new Error('tab was occluded');
      return 'data:image/png;base64,A';
    });

    const request = await new ChromeDriver(7, {
      frameDelayMs: 0,
    }).captureFrames();

    expect(request.frames.map((frame) => frame.offsetY)).toEqual([0, 1000]);
  });

  it('reports a readable reason when no frame could be captured', async () => {
    stubViewport(chromeMock, { height: 500, documentHeight: 500 });
    chromeMock.tabs.captureVisibleTab.mockRejectedValue(
      new Error('tab was occluded'),
    );
    await expect(
      new ChromeDriver(7, { frameDelayMs: 0 }).captureFrames(),
    ).rejects.toThrow('Could not take the screenshot: tab was occluded');
  });

  it('refuses to screenshot a tab that is not the visible one', async () => {
    stubViewport(chromeMock);
    // captureVisibleTab shoots whatever is on screen, so an inactive tab
    // would silently produce a picture of a different page.
    chromeMock.tabs.get.mockResolvedValue({ active: false, windowId: 1 });
    await expect(
      new ChromeDriver(7, { frameDelayMs: 0 }).captureFrames(),
    ).rejects.toThrow('Switch to that tab');
  });

  it('refuses a page it could not measure rather than throwing on a property read', async () => {
    chromeMock.scripting.executeScript.mockResolvedValue([
      { result: undefined },
    ]);
    await expect(new ChromeDriver(7).viewport()).rejects.toThrow(
      'Could not measure the page',
    );
  });

  it('stops at the frame cap on a very tall page', async () => {
    stubViewport(chromeMock, { height: 800, documentHeight: 400_000 });
    chromeMock.tabs.captureVisibleTab.mockResolvedValue(
      'data:image/png;base64,A',
    );

    const request = await new ChromeDriver(7, {
      frameDelayMs: 0,
      maxFrames: 5,
    }).captureFrames();

    expect(request.frames).toHaveLength(5);
    // The canvas must be sized to what was captured, not to the whole page.
    expect(request.height).toBe(4000);
  });
});
