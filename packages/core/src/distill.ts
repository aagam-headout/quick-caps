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

function renderLine(region: Region): string {
  const actionsText = region.actions
    .map((action) => {
      if (action.type === 'button') return `[${action.id}]${action.label} (button)`;
      if (action.type === 'input') return `[${action.id}]${action.label} (input)`;
      return `[${action.id}]${action.label}`;
    })
    .join(' ');

  const head = `[${region.id}] ${region.role}`;
  const hasSnippet = region.snippet.length > 0;

  if (!hasSnippet && !actionsText) return head;
  if (!hasSnippet) return `${head}: ${actionsText}`;
  if (!actionsText) return `${head}: "${region.snippet}"`;
  return `${head}: "${region.snippet}" ${actionsText}`;
}

/**
 * Renders every region in `ids`, in document order, indented two spaces
 * per tree depth. A region whose parent isn't in `ids` — because an
 * earlier paged call already consumed it, see distill() — still renders
 * at its true depth: the indentation reflects the region's real position
 * in the page, not the shown subset's shape.
 */
export function renderRegions(
  flat: FlatRegion[],
  ids: ReadonlySet<number>,
): string {
  return flat
    .filter((entry) => ids.has(entry.region.id))
    .map((entry) => '  '.repeat(entry.depth - 1) + renderLine(entry.region))
    .join('\n');
}
