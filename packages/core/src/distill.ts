import type { PageIR, Region } from './ir.js';
import { countTokens } from './tokenize.js';

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
 * Pre-order flatten of the region tree. Selection (next task) needs each
 * region's ancestor chain to "pull in" a selected region's ancestors for
 * free; rendering needs depth for indentation. This is the only traversal
 * distill.ts does over Region — everything downstream operates on this
 * flat list.
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

/** Matches `ownTextSnippet`'s truncation style in regions.ts, just at a
 * tighter cap: render-time snippets are capped further than storage. */
const RENDER_SNIPPET_CAP = 120;

function renderSnippet(snippet: string): string {
  return snippet.length > RENDER_SNIPPET_CAP
    ? `${snippet.slice(0, RENDER_SNIPPET_CAP - 1)}…`
    : snippet;
}

function renderLine(region: Region): string {
  const actionsText = region.actions
    .map((action) => {
      if (action.type === 'button')
        return `[${action.id}]${action.label} (button)`;
      if (action.type === 'input')
        return `[${action.id}]${action.label} (input)`;
      return `[${action.id}]${action.label}`;
    })
    .join(' ');

  const head = `[${region.id}] ${region.role}`;
  const hasSnippet = region.snippet.length > 0;
  const snippet = renderSnippet(region.snippet);

  if (!hasSnippet && !actionsText) return head;
  if (!hasSnippet) return `${head}: ${actionsText}`;
  if (!actionsText) return `${head}: "${snippet}"`;
  return `${head}: "${snippet}" ${actionsText}`;
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
  label?: string;
};

export type Distillation = {
  text: string;
  tokenCount: number;
  page: number;
  /** True iff a further `next` page would render something non-empty. */
  hasMore: boolean;
  /** True iff this page's tokenCount exceeds the requested budget — only
   * possible via fillPage's starvation fallback (see its doc comment): a
   * single candidate (plus mandatory ancestors) was force-selected onto an
   * otherwise-empty page even though it alone exceeds the budget. */
  overBudget: boolean;
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
 *
 * A candidate's marginal cost usually shrinks on a later page as ancestors
 * get consumed elsewhere, but its *own* irreducible floor — itself plus its
 * still-unconsumed ancestors, rendered alone on an otherwise-empty page —
 * does not shrink below that floor. If that floor is already over budget
 * (e.g. a container whose own line inlines many actions), skipping it
 * forever would starve it: it would never be consumed, `hasMore` would
 * never resolve to false, and pagination would never become exhaustive. So
 * if a page would otherwise select nothing at all, the highest-scored
 * remaining candidate is force-selected onto its own page — over budget if
 * it must be — trading the budget ceiling for forward progress, which is
 * the only way to keep the "no id withheld forever" guarantee.
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
  let fallbackNeeded: number[] | null = null;

  for (const candidate of sorted) {
    if (
      consumed.has(candidate.region.id) ||
      selected.has(candidate.region.id)
    ) {
      continue;
    }

    const needed: number[] = [];
    for (const parentId of candidate.parentIds) {
      if (!consumed.has(parentId) && !selected.has(parentId))
        needed.push(parentId);
    }
    needed.push(candidate.region.id);

    if (fallbackNeeded === null) fallbackNeeded = needed;

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
    // later page, where it may fit once its ancestors are consumed
    // elsewhere — and if it never does, the fallback below still surfaces
    // it eventually rather than withholding it forever.
    if (trialCount > budget) continue;

    for (const id of needed) selected.add(id);
    text = trialText;
    tokenCount = trialCount;
  }

  if (selected.size === 0 && fallbackNeeded !== null) {
    for (const id of fallbackNeeded) selected.add(id);
    text = renderRegions(flatDocOrder, selected);
    tokenCount = countTokens(text);
  }

  for (const id of selected) consumed.add(id);
  return { ids: selected, text, tokenCount };
}

function handleFor(region: Region): Handle {
  return { id: region.id, kind: 'region' };
}

function actionHandle(
  id: number,
  kind: Handle['kind'],
  label: string,
  href?: string,
): Handle {
  return href !== undefined ? { id, kind, href, label } : { id, kind, label };
}

/**
 * Turns a PageIR into a budget-capped, numbered-handle text tree, using
 * `scoreFn` to rank regions instead of the default role/density/action
 * score. `distill()` is this with the identity score function — Phase C1's
 * `find` command is the other caller, ranking by query match instead.
 */
export function distillWithScoring(
  ir: PageIR,
  scoreFn: (region: Region, baseScore: number) => number,
  opts: DistillOptions = {},
): Distillation {
  const budget = opts.tokenBudget ?? DEFAULT_BUDGET;
  const targetPage = opts.page ?? 0;

  const flatDocOrder = flattenRegions(ir.regions, scoreFn);
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
      handles[action.id] = actionHandle(
        action.id,
        action.type,
        action.label,
        action.href,
      );
    }
  }

  return {
    text: result.text,
    tokenCount: result.tokenCount,
    page: targetPage,
    hasMore,
    overBudget: result.tokenCount > budget,
    handles,
  };
}

/**
 * Turns a PageIR into a budget-capped, numbered-handle text tree. Pure
 * function over PageIR.regions — no second DOM traversal, no host API.
 * Deterministic: the same PageIR and opts always produce the same output,
 * which is what makes repeated `next` calls exhaustive and non-repeating.
 */
export function distill(ir: PageIR, opts: DistillOptions = {}): Distillation {
  return distillWithScoring(ir, (_region, baseScore) => baseScore, opts);
}
