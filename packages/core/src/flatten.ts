import type { Region } from './ir.js';

/**
 * Region flattening and scoring, deliberately kept out of distill.ts.
 *
 * distill.ts imports tokenize.ts, which pulls gpt-tokenizer's o200k BPE rank
 * table (~2.4 MB on disk) into any module graph that reaches it. The extract
 * layer wants `flattenRegions` and nothing else from distill; while these
 * symbols lived in distill.ts, extract/content.ts dragged the whole tokenizer
 * into the extension's offscreen chunk — measured at 2,080 kB, of which ~93%
 * was that table. Splitting them here drops it to ~186 kB.
 *
 * So: nothing in this file may import tokenize.ts, and these symbols must not
 * be folded back into distill.ts. distill.ts re-exports them, so the published
 * `quick-caps-core/distill` surface is unchanged either way.
 */

export type { Region };

/** Named, tunable weights — the acceptance corpus (Task 6) validates these
 * empirically; nothing here is meant to be argued about in the abstract. */
export const SCORE_WEIGHTS = {
  role: 1,
  density: 1,
  actionBonus: 2,
} as const;

const ROLE_WEIGHT: Record<string, number> = {
  main: 10,
  article: 9,
  heading: 8,
  navigation: 6,
  banner: 5,
  contentinfo: 3,
  form: 6,
  complementary: 4,
  region: 4,
  list: 3,
  listitem: 2,
  table: 5,
  generic: 1,
};

function roleWeight(role: string): number {
  return ROLE_WEIGHT[role] ?? ROLE_WEIGHT['generic']!;
}

export function scoreOf(region: Region): number {
  return (
    roleWeight(region.role) * SCORE_WEIGHTS.role +
    region.textDensity * SCORE_WEIGHTS.density +
    (region.actions.length > 0 ? SCORE_WEIGHTS.actionBonus : 0)
  );
}

/** A region plus the bookkeeping the tree itself doesn't carry: its depth
 * and full ancestor-id chain in a pre-order (document-order) walk. */
export type FlatRegion = {
  region: Region;
  depth: number;
  parentIds: number[];
  score: number;
};

/**
 * Pre-order flatten of the region tree. Selection needs each region's
 * ancestor chain to "pull in" a selected region's ancestors for free;
 * rendering needs depth for indentation. This is the only traversal any
 * consumer does over Region — everything downstream operates on this flat
 * list.
 */
export function flattenRegions(
  regions: Region[],
  scoreFn: (region: Region, baseScore: number) => number = (
    _region,
    baseScore,
  ) => baseScore,
): FlatRegion[] {
  const out: FlatRegion[] = [];
  const walk = (nodes: Region[], depth: number, parentIds: number[]): void => {
    for (const region of nodes) {
      out.push({
        region,
        depth,
        parentIds,
        score: scoreFn(region, scoreOf(region)),
      });
      walk(region.children, depth + 1, [...parentIds, region.id]);
    }
  };
  walk(regions, 1, []);
  return out;
}
