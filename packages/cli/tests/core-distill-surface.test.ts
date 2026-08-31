import { describe, expect, it } from 'vitest';
import {
  SCORE_WEIGHTS,
  flattenRegions,
  scoreOf,
  type FlatRegion,
} from 'quick-caps-core/distill';
import type { Region } from 'quick-caps-core';

/**
 * quick-caps-core is published on npm, and `flattenRegions` / `FlatRegion` are
 * part of the `./distill` subpath surface as of 0.1.0. They now live in
 * src/flatten.ts (so the extract layer can flatten without pulling in
 * gpt-tokenizer) and reach `./distill` only by re-export. This test resolves
 * the real package subpath against packages/core/dist, so it fails if that
 * re-export is ever dropped and an existing consumer's import breaks.
 */
describe('quick-caps-core/distill published surface', () => {
  const region: Region = {
    id: 1,
    role: 'main',
    tag: 'main',
    box: { x: 0, y: 0, w: 100, h: 100 },
    textLength: 40,
    snippet: 'hello',
    textDensity: 4,
    actions: [
      {
        id: 2,
        type: 'link',
        label: 'go',
        href: 'https://x.test/',
        domPath: [0, 1],
      },
    ],
    domPath: [0],
    children: [
      {
        id: 3,
        role: 'article',
        tag: 'article',
        box: { x: 0, y: 0, w: 50, h: 50 },
        textLength: 5,
        snippet: 'child',
        textDensity: 2,
        actions: [],
        domPath: [0, 0],
        children: [],
      },
    ],
  };

  it('still exports flattenRegions, scoreOf and SCORE_WEIGHTS', () => {
    expect(typeof flattenRegions).toBe('function');
    expect(typeof scoreOf).toBe('function');
    expect(SCORE_WEIGHTS).toMatchObject({
      role: 1,
      density: 1,
      actionBonus: 2,
    });
  });

  it('keeps flattenRegions behaving identically through the re-export', () => {
    const flat: FlatRegion[] = flattenRegions([region]);
    expect(flat.map((entry) => entry.region.id)).toEqual([1, 3]);
    expect(flat.map((entry) => entry.depth)).toEqual([1, 2]);
    expect(flat[1]!.parentIds).toEqual([1]);
    expect(flat[0]!.score).toBe(scoreOf(region));
  });

  it('honours the optional scoreFn override', () => {
    const flat = flattenRegions([region], (_region, baseScore) => -baseScore);
    expect(flat[0]!.score).toBe(-scoreOf(region));
  });
});
