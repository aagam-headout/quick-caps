/**
 * The UI palette: near-monochrome grays carrying structure, one blue for the
 * primary action, semantic colors only for state.
 *
 * These values approximate Vercel's published Geist scales; they are not
 * copied from an authoritative source, because the Geist documentation does not
 * publish machine-readable hexes and the `geist` npm package ships fonts only.
 * Treat the exact numbers as replaceable. What is *not* replaceable is the
 * contrast gate below: any substitution must still pass it, which is why the
 * palette lives in core next to the check rather than in a stylesheet.
 */
export type ThemeTokens = Record<string, string>;

export const lightTheme: ThemeTokens = {
  'background-100': '#ffffff',
  'background-200': '#fafafa',
  'gray-100': '#f2f2f2',
  'gray-200': '#ebebeb',
  'gray-300': '#e5e5e5',
  'gray-400': '#d4d4d4',
  'gray-500': '#a3a3a3',
  'gray-600': '#8f8f8f',
  'gray-700': '#737373',
  'gray-800': '#525252',
  'gray-900': '#404040',
  'gray-1000': '#171717',
  'blue-600': '#0072f5',
  'blue-700': '#0761d1',
  // Light-theme state colors step darker than their dark-theme counterparts:
  // #e5484d on white is 3.9:1, below the 4.5:1 body-text floor.
  'red-600': '#cd2b31',
  'amber-600': '#ab5600',
  'green-600': '#357a45',
};

export const darkTheme: ThemeTokens = {
  'background-100': '#0a0a0a',
  'background-200': '#000000',
  'gray-100': '#1a1a1a',
  'gray-200': '#1f1f1f',
  'gray-300': '#292929',
  'gray-400': '#2e2e2e',
  'gray-500': '#454545',
  'gray-600': '#878787',
  'gray-700': '#8f8f8f',
  'gray-800': '#a1a1a1',
  'gray-900': '#c9c9c9',
  'gray-1000': '#ededed',
  'blue-600': '#0072f5',
  'blue-700': '#3291ff',
  'red-600': '#ff6166',
  'amber-600': '#f5b849',
  'green-600': '#62c073',
};

export type SemanticPair = {
  name: string;
  foreground: string;
  background: string;
  /** 4.5 for body text, 3 for large text and UI boundaries. */
  minimum: number;
};

/**
 * Every foreground/background combination the popup actually renders. The gate
 * is only as good as this list: a component introducing a new pair must add it
 * here, or the pair ships unchecked.
 */
export const semanticPairs: SemanticPair[] = [
  {
    name: 'primary text on surface',
    foreground: 'gray-1000',
    background: 'background-100',
    minimum: 4.5,
  },
  {
    name: 'primary text on raised surface',
    foreground: 'gray-1000',
    background: 'gray-100',
    minimum: 4.5,
  },
  {
    name: 'secondary text on surface',
    foreground: 'gray-800',
    background: 'background-100',
    minimum: 4.5,
  },
  {
    name: 'accent text on surface',
    foreground: 'blue-700',
    background: 'background-100',
    minimum: 4.5,
  },
  {
    name: 'error text on surface',
    foreground: 'red-600',
    background: 'background-100',
    minimum: 4.5,
  },
  {
    name: 'success text on surface',
    foreground: 'green-600',
    background: 'background-100',
    minimum: 3,
  },
  {
    name: 'warning text on surface',
    foreground: 'amber-600',
    background: 'background-100',
    minimum: 3,
  },
  {
    name: 'border against surface',
    foreground: 'gray-400',
    background: 'background-100',
    minimum: 1.2,
  },
];

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`not a six-digit hex color: ${hex}`);
  const value = Number.parseInt(match[1]!, 16);
  return (
    0.2126 * channel((value >> 16) & 0xff) +
    0.7152 * channel((value >> 8) & 0xff) +
    0.0722 * channel(value & 0xff)
  );
}

export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function themeToCss(theme: ThemeTokens, selector: string): string {
  const lines = Object.entries(theme).map(
    ([name, value]) => `  --${name}: ${value};`,
  );
  return `${selector} {\n${lines.join('\n')}\n}\n`;
}
