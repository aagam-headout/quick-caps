import type { PageIR } from './ir.js';
import { flattenRegions, type FlatRegion } from './distill.js';
import { countTokens } from './tokenize.js';

export type LayoutOptions = {
  /** Hard cap on the real (tiktoken) token count of the rendered output. */
  tokenBudget?: number;
  /** 0-based page index. */
  page?: number;
};

export type LayoutPage = {
  text: string;
  tokenCount: number;
  page: number;
  hasMore: boolean;
  /** Ids present on this page, in document order — lets a caller build a
   * region-only handles map without re-flattening the tree itself. */
  regionIds: number[];
};

const DEFAULT_LAYOUT_BUDGET = 500;

function renderLayoutLine(entry: FlatRegion): string {
  const { region, depth } = entry;
  const { x, y, w, h } = region.box;
  return (
    '  '.repeat(depth - 1) +
    `[${region.id}] ${region.tag} (role=${region.role}, ${w}x${h} @ ${x},${y})`
  );
}

/**
 * Splits flattenRegions(ir.regions) — already in document order — into
 * pages by real token count, greedily filling each page until the next
 * line would exceed budget. Unlike distillWithScoring's fillPage, there is
 * no scoring, no selection, and no ancestor pull-in: every region appears
 * in exactly one page, in the order it already comes back in, because a
 * structural tree that reorders or drops regions stops being a map of the
 * page. No starvation-fallback case exists either — a single region's own
 * line carries no snippet or action text, so it is always far smaller than
 * any reasonable budget, and a single page can only ever be empty if the
 * whole tree is empty.
 */
function pagesOf(flat: FlatRegion[], budget: number): FlatRegion[][] {
  const pages: FlatRegion[][] = [[]];
  let currentText = '';
  for (const entry of flat) {
    const line = renderLayoutLine(entry);
    const candidateText = currentText ? `${currentText}\n${line}` : line;
    if (currentText && countTokens(candidateText) > budget) {
      pages.push([entry]);
      currentText = line;
    } else {
      pages[pages.length - 1]!.push(entry);
      currentText = candidateText;
    }
  }
  return pages;
}

/**
 * Turns a PageIR into a paginated, document-order structural tree — every
 * region, its role, tag, and box, indented by depth. Deterministic: the
 * same PageIR and opts always produce the same output, same as distill().
 */
export function renderLayout(ir: PageIR, opts: LayoutOptions = {}): LayoutPage {
  const budget = opts.tokenBudget ?? DEFAULT_LAYOUT_BUDGET;
  const targetPage = opts.page ?? 0;

  const flat = flattenRegions(ir.regions);
  const pages = pagesOf(flat, budget);
  const pageEntries = pages[targetPage] ?? [];
  const text = pageEntries.map(renderLayoutLine).join('\n');

  return {
    text,
    tokenCount: countTokens(text),
    page: targetPage,
    hasMore: targetPage + 1 < pages.length,
    regionIds: pageEntries.map((entry) => entry.region.id),
  };
}
