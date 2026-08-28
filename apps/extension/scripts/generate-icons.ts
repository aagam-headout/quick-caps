import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal PNG writer. There is no image tooling in this repo and the icons must
 * be real PNGs at exactly the pixel sizes their filenames claim, or Chrome
 * refuses to load the extension. The mark below (viewfinder corner brackets
 * around a faceted focus dot, on a diagonal accent gradient) is the final
 * artwork, generated rather than drawn by hand so it stays pixel-exact at
 * every required size. 16/32/48/128 are the sizes Chrome's manifest actually
 * uses; 256/512 are extra masters for the store listing and any future
 * high-DPI use.
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

/**
 * Renders at `factor`x resolution and box-filters back down to `size`,
 * averaging in premultiplied alpha. Sampling the shape functions directly at
 * one point per output pixel left hard, aliased (pixelated) edges on the
 * rotated cards; supersampling is the fix.
 */
function encodePngAA(
  size: number,
  factor: number,
  colorAt: (u: number, v: number) => Rgba,
): Uint8Array {
  const raw = new Uint8Array(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const u = (x + (sx + 0.5) / factor) / size;
          const v = (y + (sy + 0.5) / factor) / size;
          const c = colorAt(u, v);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const samples = factor * factor;
      if (a === 0) {
        raw[offset++] = 0;
        raw[offset++] = 0;
        raw[offset++] = 0;
        raw[offset++] = 0;
      } else {
        raw[offset++] = Math.round(r / a);
        raw[offset++] = Math.round(g / a);
        raw[offset++] = Math.round(b / a);
        raw[offset++] = Math.round(a / samples);
      }
    }
  }
  return finishPng(size, raw);
}

function finishPng(size: number, raw: Uint8Array): Uint8Array {
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

const ACCENT_DARK: Rgba = [0, 58, 158, 255];
const ACCENT_LIGHT: Rgba = [94, 176, 255, 255];
const SHADOW_SHADE: Rgba = [0, 20, 64, 255];
const MARK: Rgba = [255, 255, 255, 255];
const MARK_MID: Rgba = [190, 216, 255, 255];
const MARK_SHADE: Rgba = [120, 172, 245, 255];
const TRANSPARENT: Rgba = [0, 0, 0, 0];

function mix(a: Rgba, b: Rgba, t: number): Rgba {
  const clamped = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * clamped),
    Math.round(a[1] + (b[1] - a[1]) * clamped),
    Math.round(a[2] + (b[2] - a[2]) * clamped),
    255,
  ];
}

/** True inside the axis-aligned rounded rect [x0,y0]-[x1,y1], corner radius r, all in 0..1 space. */
function inRoundedRect(
  u: number,
  v: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
): boolean {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const nearLeft = u - x0 < r;
  const nearRight = x1 - u < r;
  const nearTop = v - y0 < r;
  const nearBottom = y1 - v < r;
  if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
    const cx = nearLeft ? x0 + r : x1 - r;
    const cy = nearTop ? y0 + r : y1 - r;
    return Math.hypot(u - cx, v - cy) <= r;
  }
  return true;
}

function inCircle(
  u: number,
  v: number,
  cx: number,
  cy: number,
  radius: number,
): boolean {
  return Math.hypot(u - cx, v - cy) <= radius;
}

/**
 * Signed distance from (u,v) to the boundary of a rounded square centered at
 * (0.5, 0.5), corner radius r: negative inside, 0 at the edge, positive
 * outside. The exact formula (unlike a per-axis approximation) so a rim band
 * measured off it comes out an even thickness all the way around, corners
 * included.
 */
function roundedSquareSdf(u: number, v: number, r: number): number {
  const px = Math.abs(u - 0.5);
  const py = Math.abs(v - 0.5);
  const b = 0.5 - r;
  const qx = px - b;
  const qy = py - b;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

const FIELD_CORNER = 0.18; // rounded-square field, corner radius ~18% of the edge
const BRACKET_THICKNESS = 0.07;
const BRACKET_INSET = 0.2;
const BRACKET_ARM = 0.18;
const FOCUS_DOT_RADIUS = 0.18;
const SHADOW_OFFSET = 0.02;

function inBracketSet(
  u: number,
  v: number,
  inset: number,
  arm: number,
  thickness: number,
): boolean {
  const half = thickness / 2;
  const corners: [number, number, number, number][] = [
    [inset, inset, 1, 1],
    [1 - inset, inset, -1, 1],
    [inset, 1 - inset, 1, -1],
    [1 - inset, 1 - inset, -1, -1],
  ];
  for (const [cx, cy, sx, sy] of corners) {
    const armEndX = cx + sx * arm;
    const armEndY = cy + sy * arm;
    const inHorizontal = inRoundedRect(
      u,
      v,
      Math.min(cx, armEndX),
      cy - half,
      Math.max(cx, armEndX),
      cy + half,
      half,
    );
    const inVertical = inRoundedRect(
      u,
      v,
      cx - half,
      Math.min(cy, armEndY),
      cx + half,
      Math.max(cy, armEndY),
      half,
    );
    if (inHorizontal || inVertical) return true;
  }
  return false;
}

/**
 * Four L-shaped corner brackets around a focus dot, like a camera viewfinder
 * mid-capture. The field is a diagonal gradient rather than a flat fill. The
 * brackets cast a dark shadow, and the dot is split into three facets —
 * together giving the mark some depth instead of reading as a flat sticker.
 */
function markColor(u: number, v: number): Rgba {
  const sdf = roundedSquareSdf(u, v, FIELD_CORNER);
  if (sdf > 0) return TRANSPARENT;

  // Diagonal light: lighter toward the top-left, darker toward the bottom-right.
  const light = 1 - (u + v) / 2;
  let color = mix(ACCENT_DARK, ACCENT_LIGHT, light);

  // A dark shadow, offset down-right, sits under the brackets and dot.
  const inShadow =
    inBracketSet(
      u - SHADOW_OFFSET,
      v - SHADOW_OFFSET,
      BRACKET_INSET,
      BRACKET_ARM,
      BRACKET_THICKNESS,
    ) ||
    inCircle(u - SHADOW_OFFSET, v - SHADOW_OFFSET, 0.5, 0.5, FOCUS_DOT_RADIUS);
  if (inShadow) color = mix(color, SHADOW_SHADE, 0.6);

  if (inBracketSet(u, v, BRACKET_INSET, BRACKET_ARM, BRACKET_THICKNESS)) {
    color = MARK;
  }

  if (inCircle(u, v, 0.5, 0.5, FOCUS_DOT_RADIUS)) {
    // Three facets on the dot itself: a lit face, a mid face, a shaded face —
    // the same diagonal light direction as the field, faceted rather than
    // smoothly shaded so it reads as cut, not just blurred.
    const angle = Math.atan2(v - 0.5, u - 0.5);
    const facet = Math.floor(((angle + Math.PI) / (2 * Math.PI)) * 3) % 3;
    color = facet === 0 ? MARK : facet === 1 ? MARK_MID : MARK_SHADE;
  }
  return color;
}

const here = dirname(fileURLToPath(import.meta.url));

// The four sizes Chrome's manifest actually references — these ship inside
// the extension package, so only these belong under public/.
for (const size of [16, 32, 48, 96, 128, 192]) {
  const target = join(here, '..', 'public', 'icons', `icon-${size}.png`);
  writeFileSync(target, encodePngAA(size, 4, markColor));
  console.log(`wrote ${target}`);
}

// Larger masters for the store listing and any future high-DPI use. Not
// referenced by the manifest, so they stay out of public/ and the zip.
for (const size of [256, 512]) {
  const target = join(
    here,
    '..',
    '..',
    '..',
    'docs',
    'store',
    `icon-${size}.png`,
  );
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, encodePngAA(size, 4, markColor));
  console.log(`wrote ${target}`);
}
