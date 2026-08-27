import type { Region } from './ir.js';

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
 * Pre-order flatten of the region tree. Selection (next task) needs each
 * region's ancestor chain to "pull in" a selected region's ancestors for
 * free; rendering needs depth for indentation. This is the only traversal
 * distill.ts does over Region — everything downstream operates on this
 * flat list.
 */
export function flattenRegions(regions: Region[]): FlatRegion[] {
  const out: FlatRegion[] = [];
  const walk = (nodes: Region[], depth: number, parentIds: number[]): void => {
    for (const region of nodes) {
      out.push({ region, depth, parentIds, score: scoreOf(region) });
      walk(region.children, depth + 1, [...parentIds, region.id]);
    }
  };
  walk(regions, 1, []);
  return out;
}
