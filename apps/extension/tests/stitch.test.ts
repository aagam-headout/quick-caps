import { describe, expect, it, vi } from 'vitest';
import { stitchFrames, type StitchDeps } from '../src/offscreen/stitch.js';

function fakeDeps() {
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    convertToBlob: vi.fn().mockResolvedValue({
      arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
    }),
  };
  const deps: StitchDeps = {
    createCanvas: (w: number, h: number) => {
      canvas.width = w;
      canvas.height = h;
      return canvas as unknown as OffscreenCanvas;
    },
    decode: vi.fn(async () => ({ width: 100, height: 50 })) as unknown as (
      dataUrl: string,
    ) => Promise<ImageBitmap>,
  };
  return { drawImage, canvas, deps };
}

describe('stitchFrames', () => {
  it('sizes the canvas to the full document in device pixels', async () => {
    const { canvas, deps } = fakeDeps();
    await stitchFrames(
      {
        frames: [{ dataUrl: 'a', offsetY: 0 }],
        width: 800,
        height: 1600,
        devicePixelRatio: 2,
      },
      deps,
    );
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(3200);
  });

  it('draws each frame at its scaled offset', async () => {
    const { drawImage, deps } = fakeDeps();
    await stitchFrames(
      {
        frames: [
          { dataUrl: 'a', offsetY: 0 },
          { dataUrl: 'b', offsetY: 800 },
        ],
        width: 800,
        height: 1600,
        devicePixelRatio: 2,
      },
      deps,
    );
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(drawImage.mock.calls[0]![2]).toBe(0);
    expect(drawImage.mock.calls[1]![2]).toBe(1600);
  });

  it('returns png bytes', async () => {
    const { deps } = fakeDeps();
    const bytes = await stitchFrames(
      {
        frames: [{ dataUrl: 'a', offsetY: 0 }],
        width: 10,
        height: 10,
        devicePixelRatio: 1,
      },
      deps,
    );
    expect(bytes).toEqual(new Uint8Array([1, 2]));
  });

  it('treats a zero device pixel ratio as 1 rather than collapsing the canvas', async () => {
    const { canvas, deps } = fakeDeps();
    await stitchFrames(
      {
        frames: [{ dataUrl: 'a', offsetY: 0 }],
        width: 400,
        height: 800,
        devicePixelRatio: 0,
      },
      deps,
    );
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(800);
  });

  it('throws a clear error when there are no frames', async () => {
    const { deps } = fakeDeps();
    await expect(
      stitchFrames(
        { frames: [], width: 10, height: 10, devicePixelRatio: 1 },
        deps,
      ),
    ).rejects.toThrow('no frames to stitch');
  });

  it('refuses when every frame failed, rather than returning a blank image', async () => {
    const { deps } = fakeDeps();
    deps.decode = vi.fn().mockRejectedValue(new Error('bad png')) as never;
    await expect(
      stitchFrames(
        {
          frames: [{ dataUrl: 'a', offsetY: 0 }],
          width: 80,
          height: 160,
          devicePixelRatio: 1,
        },
        deps,
      ),
    ).rejects.toThrow('None of the screenshot frames could be read');
  });

  it('scales the canvas down instead of exceeding the browser limits', async () => {
    const { canvas, deps } = fakeDeps();
    // 3x on a 20000px-tall page is ~1.9 gigapixels: Chrome creates the canvas
    // and then silently draws nothing on it.
    await stitchFrames(
      {
        frames: [{ dataUrl: 'a', offsetY: 0 }],
        width: 1600,
        height: 20_000,
        devicePixelRatio: 3,
      },
      deps,
    );
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(256 * 1024 * 1024);
    expect(canvas.width).toBeGreaterThan(0);
  });

  it('survives a zero or NaN dimension without throwing on canvas construction', async () => {
    const { canvas, deps } = fakeDeps();
    await stitchFrames(
      {
        frames: [{ dataUrl: 'a', offsetY: 0 }],
        width: Number.NaN,
        height: 0,
        devicePixelRatio: 1,
      },
      deps,
    );
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
  });

  it('releases each decoded bitmap', async () => {
    const close = vi.fn();
    const { deps } = fakeDeps();
    deps.decode = vi.fn(async () => ({
      width: 100,
      height: 50,
      close,
    })) as never;
    await stitchFrames(
      {
        frames: [
          { dataUrl: 'a', offsetY: 0 },
          { dataUrl: 'b', offsetY: 500 },
        ],
        width: 800,
        height: 1000,
        devicePixelRatio: 1,
      },
      deps,
    );
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('skips a frame that fails to decode and still returns an image', async () => {
    const { deps, drawImage } = fakeDeps();
    deps.decode = vi
      .fn()
      .mockRejectedValueOnce(new Error('bad png'))
      .mockResolvedValue({ width: 100, height: 50 }) as never;

    const bytes = await stitchFrames(
      {
        frames: [
          { dataUrl: 'bad', offsetY: 0 },
          { dataUrl: 'good', offsetY: 800 },
        ],
        width: 800,
        height: 1600,
        devicePixelRatio: 1,
      },
      deps,
    );

    // A partial screenshot beats no capture at all.
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(drawImage).toHaveBeenCalledTimes(1);
  });
});
