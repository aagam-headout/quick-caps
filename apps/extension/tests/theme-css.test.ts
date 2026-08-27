import { describe, expect, it } from 'vitest';
import { generateThemeCss } from '../scripts/generate-theme-css.js';

describe('generateThemeCss', () => {
  const css = generateThemeCss();

  it('defines the light palette on bare :root', () => {
    expect(css).toMatch(/^:root \{/m);
    expect(css).toContain('--background-100: #ffffff;');
  });

  it('overrides under prefers-color-scheme, guarded against an explicit light choice', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(':root:not([data-theme="light"])');
  });

  it('overrides again under an explicit dark attribute so the toggle wins', () => {
    expect(css).toContain(':root[data-theme="dark"]');
  });

  it('defines semantic aliases so components never reference a raw scale', () => {
    for (const alias of [
      '--surface',
      '--surface-raised',
      '--border',
      '--text-primary',
      '--text-secondary',
      '--accent',
      '--accent-hover',
      '--error',
      '--warning',
      '--success',
    ]) {
      expect(css).toContain(`${alias}:`);
    }
  });

  it('contains no hex literal in the alias layer', () => {
    const aliasSection = css.slice(css.indexOf('--surface:'));
    expect(aliasSection).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it('emits the dark palette exactly twice — once per selector', () => {
    expect([...css.matchAll(/--gray-1000: #ededed;/g)]).toHaveLength(2);
  });
});
