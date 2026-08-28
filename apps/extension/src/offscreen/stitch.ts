import type { StitchRequest } from '../background/chrome-driver.js';

/** Refuses to hand back a screenshot bigger than this - a runaway stitch
 * (huge page, high DPI) should fail with a clear message instead of landing
 * an enormous file in the user's downloads. */
const MAX_OUTPUT_BYTES = 200 * 1024 * 1024;

/**
 * Canvas limits Chrome enforces itself. Past either one the canvas is created
 * but every draw silently no-ops, so the user gets a blank PNG and no error -
 * scale the image down to fit instead, which loses resolution but keeps the
 * whole page.
 */
const MAX_CANVAS_SIDE = 32_767;
const MAX_CANVAS_AREA = 256 * 1024 * 1024;

const formatMB = (bytes: number): string =>
  `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export type StitchDeps = {
  createCanvas: (width: number, height: number) => OffscreenCanvas;
  decode: (dataUrl: string) => Promise<ImageBitmap>;
};

export const defaultStitchDeps: StitchDeps = {
  createCanvas: (width, height) => new OffscreenCanvas(width, height),
  decode: async (dataUrl) => {
    const response = await fetch(dataUrl);
    return createImageBitmap(await response.blob());
  },
};

/**
 * The device-pixel scale the canvas can actually hold.
 *
 * Returns the requested ratio untouched in the common case; shrinks it only
 * when the full-resolution canvas would exceed a Chrome limit.
 */
export function fittedScale(
  width: number,
  height: number,
  ratio: number,
): number {
  let scale = ratio;
  const sideLimit = Math.min(
    MAX_CANVAS_SIDE / Math.max(width, 1),
    MAX_CANVAS_SIDE / Math.max(height, 1),
  );
  if (scale > sideLimit) scale = sideLimit;
  const area = width * height * scale * scale;
  if (area > MAX_CANVAS_AREA) {
    scale = Math.sqrt(MAX_CANVAS_AREA / Math.max(width * height, 1));
  }
  return Math.max(scale, 0.01);
}

/**
 * Composes viewport frames into one full-page PNG.
 *
 * A frame that fails to decode is skipped rather than failing the capture: a
 * partial screenshot is worth more than none, and the screenshot is one
 * optional part of a larger archive. Every frame failing is a different story
 * - that would produce a blank image that looks like a captured blank page.
 */
export async function stitchFrames(
  request: StitchRequest,
  deps: StitchDeps = defaultStitchDeps,
): Promise<Uint8Array> {
  if (request.frames.length === 0) throw new Error('no frames to stitch');

  const positive = (value: number, fallback: number): number =>
    Number.isFinite(value) && value > 0 ? value : fallback;
  // A zero or NaN dimension reaching `new OffscreenCanvas` throws something
  // opaque ("Failed to construct 'OffscreenCanvas'"); a 1x1 fallback at least
  // produces a real, if useless, image and never a crash mid-capture.
  const width = positive(request.width, 1);
  const height = positive(request.height, 1);
  const ratio = positive(request.devicePixelRatio, 1);
  const scale = fittedScale(width, height, ratio);

  let canvas: OffscreenCanvas;
  try {
    canvas = deps.createCanvas(
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale)),
    );
  } catch {
    throw new Error(
      'The page is too large to screenshot in one image. Capture a shorter section, or turn the screenshot off.',
    );
  }
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error(
      'Could not prepare the screenshot canvas. Close some tabs and try again.',
    );
  }

  let drawn = 0;
  let lastError: unknown;
  for (const frame of request.frames) {
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await deps.decode(frame.dataUrl);
      const y = Math.round(frame.offsetY * scale);
      if (scale === ratio) {
        context.drawImage(bitmap, 0, y);
      } else {
        // Downscaled to fit the canvas: the frame's own pixels were captured
        // at `ratio`, so map them onto the smaller canvas explicitly.
        const factor = scale / ratio;
        context.drawImage(
          bitmap,
          0,
          y,
          bitmap.width * factor,
          bitmap.height * factor,
        );
      }
      drawn++;
    } catch (error) {
      lastError = error;
      /* skip an undecodable frame; the rest of the image is still useful */
    } finally {
      // Bitmaps hold their decoded pixels until closed; a 40-frame page keeps
      // hundreds of MB alive without this.
      bitmap?.close?.();
    }
  }

  if (drawn === 0) {
    const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
    throw new Error(
      `None of the screenshot frames could be read${detail}. The rest of the capture is unaffected.`,
    );
  }

  let blob: Blob;
  try {
    blob = await canvas.convertToBlob({ type: 'image/png' });
  } catch {
    throw new Error(
      'The screenshot could not be encoded - the page is likely too large. Try turning the screenshot off.',
    );
  }
  if (blob.size > MAX_OUTPUT_BYTES) {
    throw new Error(
      `Screenshot is ${formatMB(blob.size)}, over the ${formatMB(MAX_OUTPUT_BYTES)} limit`,
    );
  }
  return new Uint8Array(await blob.arrayBuffer());
}
