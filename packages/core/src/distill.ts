import type { PageIR, Region } from './ir.js';
import { countTokens } from './tokenize.js';

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

export type DistillOptions = {
  /** Hard cap on the real (tiktoken) token count of the rendered output. */
  tokenBudget?: number;
  /** 0-based page index. Page 0 is what `open` shows. */
  page?: number;
};

export type Handle = {
  id: number;
  kind: 'region' | 'link' | 'button' | 'input';
  href?: string;
};

export type Distillation = {
  text: string;
  tokenCount: number;
  page: number;
  /** True iff a further `next` page would render something non-empty. */
  hasMore: boolean;
  handles: Record<number, Handle>;
};

const DEFAULT_BUDGET = 500;

/**
 * Fills one page: walks `sorted` (already ranked by score desc) skipping
 * anything in `consumed`, and for each candidate, computes the marginal
 * cost of adding it plus any of its ancestors not yet shown, via the real
 * renderer and token counter — not an estimate. Stops the moment that
 * marginal cost would exceed budget. Every id this page renders — the
 * candidate itself or a pulled-in ancestor — is added to `consumed`, so no
 * id is ever rendered on two pages; ancestors are exempt from the SCORE
 * gate (a low-scoring ancestor still shows up for a high-scoring child)
 * but not from the consumed-tracking that keeps paging exhaustive.
 */
function fillPage(
  sorted: FlatRegion[],
  flatDocOrder: FlatRegion[],
  consumed: Set<number>,
  budget: number,
): { ids: Set<number>; text: string; tokenCount: number } {
  const selected = new Set<number>();
  let text = '';
  let tokenCount = 0;

  for (const candidate of sorted) {
    if (consumed.has(candidate.region.id) || selected.has(candidate.region.id)) {
      continue;
    }

    const needed: number[] = [];
    for (const parentId of candidate.parentIds) {
      if (!consumed.has(parentId) && !selected.has(parentId)) needed.push(parentId);
    }
    needed.push(candidate.region.id);

    const trial = new Set(selected);
    for (const id of needed) trial.add(id);
    const trialText = renderRegions(flatDocOrder, trial);
    const trialCount = countTokens(trialText);

    // `continue`, not `break`: `sorted` is score-descending, but cost isn't
    // monotonic with score (a high-scoring candidate may need an expensive
    // unconsumed ancestor pulled in). Breaking here would let one oversized
    // candidate blank out an entire page, even the top-scored one, on a
    // small budget. Skipping keeps scanning for a cheaper, lower-scored
    // candidate that still fits; anything skipped remains a candidate for a
    // later page, where its marginal cost can only shrink as ancestors get
    // consumed elsewhere, so paging still terminates and stays exhaustive.
    if (trialCount > budget) continue;

    for (const id of needed) selected.add(id);
    text = trialText;
    tokenCount = trialCount;
  }

  for (const id of selected) consumed.add(id);
  return { ids: selected, text, tokenCount };
}

function handleFor(region: Region): Handle {
  return { id: region.id, kind: 'region' };
}

function actionHandle(id: number, kind: Handle['kind'], href?: string): Handle {
  return href !== undefined ? { id, kind, href } : { id, kind };
}

/**
 * Turns a PageIR into a budget-capped, numbered-handle text tree. Pure
 * function over PageIR.regions — no second DOM traversal, no host API.
 * Deterministic: the same PageIR and opts always produce the same output,
 * which is what makes repeated `next` calls exhaustive and non-repeating.
 */
export function distill(ir: PageIR, opts: DistillOptions = {}): Distillation {
  const budget = opts.tokenBudget ?? DEFAULT_BUDGET;
  const targetPage = opts.page ?? 0;

  const flatDocOrder = flattenRegions(ir.regions);
  const sorted = [...flatDocOrder].sort(
    (a, b) => b.score - a.score || a.region.id - b.region.id,
  );

  const consumed = new Set<number>();
  let result = { ids: new Set<number>(), text: '', tokenCount: 0 };
  for (let page = 0; page <= targetPage; page += 1) {
    result = fillPage(sorted, flatDocOrder, consumed, budget);
  }

  const hasMore = sorted.some((entry) => !consumed.has(entry.region.id));

  const handles: Record<number, Handle> = {};
  for (const entry of flatDocOrder) {
    if (!result.ids.has(entry.region.id)) continue;
    handles[entry.region.id] = handleFor(entry.region);
    for (const action of entry.region.actions) {
      handles[action.id] = actionHandle(action.id, action.type, action.href);
    }
  }

  return {
    text: result.text,
    tokenCount: result.tokenCount,
    page: targetPage,
    hasMore,
    handles,
  };
}
