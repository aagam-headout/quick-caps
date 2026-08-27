import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  darkTheme,
  lightTheme,
  relativeLuminance,
  semanticPairs,
  themeToCss,
} from '../src/theme.js';

describe('contrast math', () => {
  it('computes luminance of the extremes', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('gives 21:1 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('is order independent', () => {
    expect(contrastRatio('#171717', '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', '#171717'),
      5,
    );
  });

  it('rejects a value that is not a six-digit hex', () => {
    expect(() => relativeLuminance('#fff')).toThrow('six-digit');
  });
});

describe('theme completeness', () => {
  it('defines the same token names in both themes', () => {
    expect(Object.keys(lightTheme).sort()).toEqual(
      Object.keys(darkTheme).sort(),
    );
  });

  it('has every token as a six-digit hex', () => {
    for (const [name, value] of Object.entries({
      ...lightTheme,
      ...darkTheme,
    })) {
      expect(value, name).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('names every token referenced by a semantic pair', () => {
    for (const pair of semanticPairs) {
      expect(lightTheme[pair.foreground], pair.name).toBeDefined();
      expect(lightTheme[pair.background], pair.name).toBeDefined();
      expect(darkTheme[pair.foreground], pair.name).toBeDefined();
      expect(darkTheme[pair.background], pair.name).toBeDefined();
    }
  });
});

describe('WCAG AA gate', () => {
  it.each(semanticPairs)(
    '$name meets its minimum in the light theme',
    ({ foreground, background, minimum, name }) => {
      const ratio = contrastRatio(
        lightTheme[foreground]!,
        lightTheme[background]!,
      );
      expect(
        ratio,
        `${name} light: ${ratio.toFixed(2)}:1, needs ${minimum}:1`,
      ).toBeGreaterThanOrEqual(minimum);
    },
  );

  it.each(semanticPairs)(
    '$name meets its minimum in the dark theme',
    ({ foreground, background, minimum, name }) => {
      const ratio = contrastRatio(
        darkTheme[foreground]!,
        darkTheme[background]!,
      );
      expect(
        ratio,
        `${name} dark: ${ratio.toFixed(2)}:1, needs ${minimum}:1`,
      ).toBeGreaterThanOrEqual(minimum);
    },
  );
});

describe('themeToCss', () => {
  it('emits custom properties under the given selector', () => {
    const css = themeToCss(lightTheme, ':root');
    expect(css).toContain(':root {');
    expect(css).toContain('--gray-1000:');
    expect(css.trimEnd().endsWith('}')).toBe(true);
  });

  it('emits every token', () => {
    const css = themeToCss(darkTheme, ':root[data-theme="dark"]');
    for (const name of Object.keys(darkTheme)) {
      expect(css).toContain(`--${name}:`);
    }
  });
});
