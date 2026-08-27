import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generates the 1280x800 Chrome Web Store promo tile: the same viewfinder
 * mark used for the extension icons, centered on the accent field.
 * Duplicates generate-icons.ts's tiny PNG writer rather than sharing it —
 * this is a one-off store asset, not part of the extension build, and the
 * two scripts have no reason to stay coupled.
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
 * Renders at 2x resolution and box-filters back down, averaging in
 * premultiplied alpha, so the rotated card edges come out anti-aliased
 * instead of jagged.
 */
function encodePng(
  width: number,
  height: number,
  colorAt: (x: number, y: number) => Rgba,
): Uint8Array {
  const factor = 2;
  const raw = new Uint8Array(height * (width * 4 + 1));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const c = colorAt(x + (sx + 0.5) / factor, y + (sy + 0.5) / factor);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const samples = factor * factor;
      raw[offset++] = a === 0 ? 0 : Math.round(r / a);
      raw[offset++] = a === 0 ? 0 : Math.round(g / a);
      raw[offset++] = a === 0 ? 0 : Math.round(b / a);
      raw[offset++] = Math.round(a / samples);
    }
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
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
const ACCENT_DARK: Rgba = [0, 84, 189, 255];
const MARK: Rgba = [255, 255, 255, 255];
const MARK_MID: Rgba = [190, 216, 255, 255];
const MARK_SHADE: Rgba = [120, 172, 245, 255];

const WIDTH = 1280;
const HEIGHT = 800;
const MARK_SIZE = 480; // square mark centered in the tile

function mix(a: Rgba, b: Rgba, t: number): Rgba {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    255,
  ];
}

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

// Mirrors generate-icons.ts's markColor: viewfinder brackets + faceted dot.
const BRACKET_THICKNESS = 0.07;
const BRACKET_INSET = 0.2;
const BRACKET_ARM = 0.18;
const FOCUS_DOT_RADIUS = 0.18;
const SHADOW_OFFSET = 0.02;

function inBracketSet(u: number, v: number): boolean {
  const half = BRACKET_THICKNESS / 2;
  const corners: [number, number, number, number][] = [
    [BRACKET_INSET, BRACKET_INSET, 1, 1],
    [1 - BRACKET_INSET, BRACKET_INSET, -1, 1],
    [BRACKET_INSET, 1 - BRACKET_INSET, 1, -1],
    [1 - BRACKET_INSET, 1 - BRACKET_INSET, -1, -1],
  ];
  for (const [cx, cy, sx, sy] of corners) {
    const armEndX = cx + sx * BRACKET_ARM;
    const armEndY = cy + sy * BRACKET_ARM;
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

function tile(x: number, y: number): Rgba {
  // Vertical gradient field so the flat mark reads as a tile, not an icon.
  const t = y / HEIGHT;
  const bg = mix(ACCENT, ACCENT_DARK, t);

  const left = (WIDTH - MARK_SIZE) / 2;
  const top = (HEIGHT - MARK_SIZE) / 2;
  const mx = x - left;
  const my = y - top;
  if (mx < 0 || mx >= MARK_SIZE || my < 0 || my >= MARK_SIZE) return bg;

  const u = mx / MARK_SIZE;
  const v = my / MARK_SIZE;

  let color = bg;

  const inShadow =
    inBracketSet(u - SHADOW_OFFSET, v - SHADOW_OFFSET) ||
    inCircle(u - SHADOW_OFFSET, v - SHADOW_OFFSET, 0.5, 0.5, FOCUS_DOT_RADIUS);
  if (inShadow) color = mix(color, ACCENT_DARK, 0.45);

  if (inBracketSet(u, v)) color = MARK;

  if (inCircle(u, v, 0.5, 0.5, FOCUS_DOT_RADIUS)) {
    const angle = Math.atan2(v - 0.5, u - 0.5);
    const facet = Math.floor(((angle + Math.PI) / (2 * Math.PI)) * 3) % 3;
    color = facet === 0 ? MARK : facet === 1 ? MARK_MID : MARK_SHADE;
  }
  return color;
}

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', '..', '..', 'docs', 'store', 'promo-tile.png');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, encodePng(WIDTH, HEIGHT, tile));
console.log(`wrote ${target}`);
