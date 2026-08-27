import { describe, expect, it } from 'vitest';
import {
  buildTokens,
  normalizeColor,
  normalizeLength,
  tallyComputedStyles,
} from '../src/tokens.js';
import { emptyTally } from '../src/collect.js';
import { fixtureDocument } from './fake-driver.js';

describe('normalizeColor', () => {
  it('expands three-digit hex to six and lowercases', () => {
    expect(normalizeColor('#FFF')).toBe('#ffffff');
  });

  it('converts opaque rgb to hex', () => {
    expect(normalizeColor('rgb(255, 255, 255)')).toBe('#ffffff');
    expect(normalizeColor('rgb(23,23,23)')).toBe('#171717');
  });

  it('keeps alpha as rgba with a normalized alpha', () => {
    expect(normalizeColor('rgba(0, 0, 0, 0.50)')).toBe('rgba(0,0,0,0.5)');
  });

  it('treats fully transparent as a single token', () => {
    expect(normalizeColor('rgba(0, 0, 0, 0)')).toBe('transparent');
    expect(normalizeColor('transparent')).toBe('transparent');
  });

  it('returns null for something that is not a color', () => {
    expect(normalizeColor('none')).toBeNull();
    expect(normalizeColor('')).toBeNull();
  });

  it('collapses every spelling of white to one token', () => {
    const spellings = [
      '#FFF',
      '#ffffff',
      'rgb(255,255,255)',
      'rgba(255,255,255,1)',
    ];
    expect(new Set(spellings.map(normalizeColor)).size).toBe(1);
  });
});

describe('normalizeLength', () => {
  it('drops a trailing zero decimal', () => {
    expect(normalizeLength('16.00px')).toBe('16px');
  });

  it('rounds to two decimals', () => {
    expect(normalizeLength('16.666px')).toBe('16.67px');
  });

  it('normalizes zero regardless of unit', () => {
    expect(normalizeLength('0px')).toBe('0');
    expect(normalizeLength('0em')).toBe('0');
  });

  it('returns null for auto and normal', () => {
    expect(normalizeLength('auto')).toBeNull();
    expect(normalizeLength('normal')).toBeNull();
  });
});

describe('tallyComputedStyles', () => {
  it('counts normalized values per property group', () => {
    const doc = fixtureDocument('static');
    const elements = [...doc.querySelectorAll('h1, p')];
    const tally = tallyComputedStyles(
      elements,
      () => ({
        color: 'rgb(23, 23, 23)',
        'background-color': 'rgba(0, 0, 0, 0)',
        'font-family': 'Inter, sans-serif',
        'font-size': '16.00px',
        'line-height': '24px',
        'font-weight': '400',
        'border-radius': '6px',
        'box-shadow': 'none',
        'padding-top': '8px',
        'margin-bottom': '16px',
      }),
      emptyTally(),
    );
    expect(tally.color['#171717']).toBe(elements.length);
    expect(tally.fontSize['16px']).toBe(elements.length);
    expect(tally.backgroundColor['transparent']).toBe(elements.length);
    expect(tally.spacing['8px']).toBe(elements.length);
    expect(tally.spacing['16px']).toBe(elements.length);
    expect(tally.boxShadow).toEqual({});
  });

  it('ignores zero spacing, which is not a design decision', () => {
    const tally = tallyComputedStyles(
      [...fixtureDocument('static').querySelectorAll('h1')],
      () => ({ 'padding-top': '0px', 'margin-bottom': '12px' }),
      emptyTally(),
    );
    expect(tally.spacing['0']).toBeUndefined();
    expect(tally.spacing['12px']).toBe(1);
  });
});

describe('buildTokens', () => {
  it('sorts each group by descending count', () => {
    const report = buildTokens(
      { ...emptyTally(), color: { '#111111': 2, '#000000': 9, '#222222': 5 } },
      { minCount: 1, maxPerGroup: 10 },
    );
    expect(Object.keys(report.color!)).toEqual([
      '#000000',
      '#222222',
      '#111111',
    ]);
  });

  it('drops values below minCount', () => {
    const report = buildTokens(
      { ...emptyTally(), color: { '#000000': 9, '#ffffff': 1 } },
      { minCount: 2, maxPerGroup: 10 },
    );
    expect(Object.keys(report.color!)).toEqual(['#000000']);
  });

  it('caps each group at maxPerGroup', () => {
    const color = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `#${i.toString(16).padStart(6, '0')}`,
        40 - i,
      ]),
    );
    const report = buildTokens(
      { ...emptyTally(), color },
      { minCount: 1, maxPerGroup: 12 },
    );
    expect(Object.keys(report.color!)).toHaveLength(12);
  });

  it('omits empty groups entirely', () => {
    const report = buildTokens(emptyTally(), { minCount: 1, maxPerGroup: 10 });
    expect(report.color).toBeUndefined();
  });

  it('breaks count ties deterministically', () => {
    const report = buildTokens(
      { ...emptyTally(), color: { '#bbbbbb': 3, '#aaaaaa': 3 } },
      { minCount: 1, maxPerGroup: 10 },
    );
    expect(Object.keys(report.color!)).toEqual(['#aaaaaa', '#bbbbbb']);
  });
});
