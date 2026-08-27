import type { StyleTally, StyleTallyKey } from './ir.js';

/** Ranked token values per property group. */
export type TokenReport = Partial<
  Record<StyleTallyKey, Record<string, number>>
>;

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX_LONG = /^#[0-9a-f]{6}$/i;
const RGB =
  /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/i;

function hexPair(value: number): string {
  return Math.round(value).toString(16).padStart(2, '0');
}

/**
 * One spelling per colour. Without this, `#FFF`, `#ffffff`, and
 * `rgb(255,255,255)` rank as three separate tokens, and a frequency table over
 * three spellings of white is noise rather than a design system.
 */
export function normalizeColor(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value || value === 'none' || value === 'currentcolor') return null;
  if (value === 'transparent') return 'transparent';

  const short = HEX_SHORT.exec(value);
  if (short) {
    const [, r, g, b] = short;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  if (HEX_LONG.test(value)) return value;

  const rgb = RGB.exec(value);
  if (rgb) {
    const red = Number(rgb[1]);
    const green = Number(rgb[2]);
    const blue = Number(rgb[3]);
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
    if (alpha === 0) return 'transparent';
    if (alpha === 1) return `#${hexPair(red)}${hexPair(green)}${hexPair(blue)}`;
    return `rgba(${Math.round(red)},${Math.round(green)},${Math.round(blue)},${Number(alpha.toFixed(3))})`;
  }
  return null;
}

export function normalizeLength(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value || value === 'auto' || value === 'normal' || value === 'none') {
    return null;
  }
  const match = /^(-?[\d.]+)([a-z%]*)$/.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (Number.isNaN(amount)) return null;
  if (amount === 0) return '0';
  return `${Number(amount.toFixed(2))}${match[2] ?? ''}`;
}

const SPACING_PROPERTIES = [
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'gap',
];

function bump(bucket: Record<string, number>, key: string | null): void {
  if (key === null) return;
  bucket[key] = (bucket[key] ?? 0) + 1;
}

/**
 * Reads computed styles through an injected reader — core cannot call
 * getComputedStyle itself, which is exactly what makes this testable.
 */
export function tallyComputedStyles(
  elements: Iterable<Element>,
  read: (el: Element) => Record<string, string>,
  tally: StyleTally,
): StyleTally {
  for (const el of elements) {
    const style = read(el);
    bump(tally.color, normalizeColor(style['color'] ?? ''));
    bump(
      tally.backgroundColor,
      normalizeColor(style['background-color'] ?? ''),
    );
    bump(tally.borderColor, normalizeColor(style['border-top-color'] ?? ''));

    const family = (style['font-family'] ?? '').trim().toLowerCase();
    if (family) bump(tally.fontFamily, family);
    bump(tally.fontSize, normalizeLength(style['font-size'] ?? ''));
    bump(tally.lineHeight, normalizeLength(style['line-height'] ?? ''));

    const weight = (style['font-weight'] ?? '').trim();
    if (weight) bump(tally.fontWeight, weight);
    bump(tally.borderRadius, normalizeLength(style['border-radius'] ?? ''));

    const shadow = (style['box-shadow'] ?? '').trim().toLowerCase();
    if (shadow && shadow !== 'none') bump(tally.boxShadow, shadow);

    for (const property of SPACING_PROPERTIES) {
      const normalized = normalizeLength(style[property] ?? '');
      // Zero spacing is the absence of a decision, not a token.
      if (normalized && normalized !== '0') bump(tally.spacing, normalized);
    }
  }
  return tally;
}

export type BuildTokensOptions = {
  /** Values seen fewer times than this are noise, not tokens. */
  minCount: number;
  maxPerGroup: number;
};

export function buildTokens(
  tally: StyleTally,
  options: BuildTokensOptions,
): TokenReport {
  const report: TokenReport = {};
  for (const [group, values] of Object.entries(tally) as [
    StyleTallyKey,
    Record<string, number>,
  ][]) {
    const ranked = Object.entries(values)
      .filter(([, count]) => count >= options.minCount)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, options.maxPerGroup);
    if (ranked.length > 0) report[group] = Object.fromEntries(ranked);
  }
  return report;
}
