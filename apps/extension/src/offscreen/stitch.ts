import type { StitchRequest } from '../background/chrome-driver.js';

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
 * Composes viewport frames into one full-page PNG.
 *
 * A frame that fails to decode is skipped rather than failing the capture: a
 * partial screenshot is worth more than none, and the screenshot is one
 * optional part of a larger archive.
 */
export async function stitchFrames(
  request: StitchRequest,
  deps: StitchDeps = defaultStitchDeps,
): Promise<Uint8Array> {
  if (request.frames.length === 0) throw new Error('no frames to stitch');

  const ratio = request.devicePixelRatio || 1;
  const canvas = deps.createCanvas(
    Math.round(request.width * ratio),
    Math.round(request.height * ratio),
  );
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2d context unavailable in offscreen canvas');

  for (const frame of request.frames) {
    try {
      const bitmap = await deps.decode(frame.dataUrl);
      context.drawImage(bitmap, 0, Math.round(frame.offsetY * ratio));
    } catch {
      /* skip an undecodable frame; the rest of the image is still useful */
    }
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}
