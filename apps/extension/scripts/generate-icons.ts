import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal PNG writer. There is no image tooling in this repo and the icons must
 * be real PNGs at exactly the pixel sizes their filenames claim, or Chrome
 * refuses to load the extension. These are placeholders: Task 18 of the plan
 * replaces them with final artwork.
 */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  body.set(new TextEncoder().encode(type), 0);
  body.set(data, 4);
  const out = new Uint8Array(body.length + 8);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(out.length - 4, crc32(body));
  return out;
}

type Rgba = [number, number, number, number];

function encodePng(
  size: number,
  pixel: (x: number, y: number) => Rgba,
): Uint8Array {
  const raw = new Uint8Array(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, size);
  header.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return new Uint8Array([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    ...chunk('IEND', new Uint8Array()),
  ]);
}

const ACCENT: Rgba = [0, 114, 245, 255];
const MARK: Rgba = [255, 255, 255, 255];
const TRANSPARENT: Rgba = [0, 0, 0, 0];

/** A page with a downward arrow: capture, then save. */
function captureMark(size: number) {
  return (x: number, y: number): Rgba => {
    const u = x / size;
    const v = y / size;
    // Rounded-square field, corner radius ~18% of the edge.
    const r = 0.18;
    const dx = Math.max(r - u, 0, u - (1 - r));
    const dy = Math.max(r - v, 0, v - (1 - r));
    if (Math.hypot(dx, dy) > r) return TRANSPARENT;

    const inTray = v > 0.72 && v < 0.82 && u > 0.24 && u < 0.76;
    const inStem = u > 0.44 && u < 0.56 && v > 0.2 && v < 0.52;
    const arrowHalf = (0.66 - v) * 0.9;
    const inHead = v >= 0.5 && v < 0.66 && Math.abs(u - 0.5) < arrowHalf;
    return inTray || inStem || inHead ? MARK : ACCENT;
  };
}

const here = dirname(fileURLToPath(import.meta.url));
for (const size of [16, 32, 48, 128]) {
  const target = join(here, '..', 'public', 'icons', `icon-${size}.png`);
  writeFileSync(target, encodePng(size, captureMark(size)));
  console.log(`wrote ${target}`);
}
