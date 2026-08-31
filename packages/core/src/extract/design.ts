import type { StyleSource } from '../ir.js';
import { normalizeLength } from '../tokens.js';
import type {
  Breakpoint,
  ComponentPattern,
  ComponentVariant,
  DeclaredFont,
  ExtractorContext,
  ExtractorMap,
  GridInference,
} from './types.js';

/**
 * Stage 1 of the design domain: everything derivable from the parsed document
 * and the stylesheet text the IR already carries. Fonts actually loaded versus
 * declared, z-index and overlay inventory, page-wide contrast failures, and
 * dark-mode support are Stage 2 — they need sampled per-element styles that
 * `Region` does not carry — and DesignReport has no field for them, so nothing
 * here is left absent.
 *
 * The CSS readers below are regex-and-brace-matching, not a parser. That is a
 * deliberate ceiling: core takes no new dependency, and tokens.ts already
 * normalizes CSS values by regex for the same reason. The cost is that
 * pathological CSS (a `{` inside a string, a comment containing `@media`) reads
 * slightly wrong; the benefit is that a malformed sheet degrades to a missed
 * rule instead of a throw.
 */

const REM_PX = 16;

/** A max-width below this is constraining an icon or a text column, not laying
 * out a page container, and reporting it as a breakpoint-adjacent container
 * width is noise. */
const MIN_CONTAINER_WIDTH = 480;

/** Ranked like buildTokens ranks tokens: a long tail of two-instance shapes is
 * not a design system, and an uncapped list is unreadable on a real page. */
const MAX_PATTERNS = 50;

/** A kind is reported once this many instances stand behind it, across every
 * variant — the same bar as before, raised one level. Applying it per signature
 * made the feature's own goal ("4 button variants") unreportable, because
 * variants are distinct signatures by design and a page with one primary and
 * one secondary button counted 1 for each and reported neither. */
const MIN_INSTANCES = 2;

/** Utility-class walls and per-instance hashes that outlive normalizeClassToken
 * can push a single kind into hundreds of one-off shapes. The cap costs the
 * tail: variants past it are invisible individually, and because `count` is the
 * total across every variant that qualified, a capped kind's `count` exceeds the
 * sum of the variants listed. That is the honest direction to be wrong in — the
 * family's weight is real, only the enumeration is truncated. */
const MAX_VARIANTS = 8;

const MAX_EXAMPLES = 3;

/** Families the author did not choose — they are fallback keywords, and
 * reporting them as declared fonts would drown the two names that matter. */
const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
  '-apple-system',
  'blinkmacsystemfont',
  'inherit',
  'initial',
  'unset',
  'revert',
]);

/** Tags that are a component shape on their own, so an unclassed instance of
 * one still counts. Everything else needs a class or a role to be considered —
 * an unclassed `<p>` is prose, not a repeated pattern. */
const COMPONENT_TAGS = new Set([
  'button',
  'a',
  'input',
  'select',
  'textarea',
  'label',
  'li',
  'article',
  'section',
  'aside',
  'nav',
  'form',
  'figure',
  'table',
  'tr',
  'th',
  'td',
  'img',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

// ---------------------------------------------------------------------------
// component inventory
// ---------------------------------------------------------------------------

/**
 * One class token, stripped of what varies per instance.
 *
 * Segments (split on `-` and `_`) are dropped when they look like a build hash
 * — four or more characters mixing letters and digits, as CSS Modules and
 * styled-components emit — and digit-only segments collapse to `#`, because a
 * utility scale like `px-4` versus `px-2` is spacing, not a different
 * component. What survives is the author's name for the thing.
 */
function normalizeClassToken(token: string): string {
  const segments = token.toLowerCase().split(/[-_]+/);
  const kept: string[] = [];
  for (const segment of segments) {
    if (!segment) continue;
    const hasLetter = /[a-z]/.test(segment);
    const hasDigit = /\d/.test(segment);
    if (hasLetter && hasDigit && segment.length >= 4) continue;
    kept.push(hasDigit && !hasLetter ? '#' : segment);
  }
  return kept.join('-');
}

/**
 * The structural signature an element is tallied under:
 *
 *   `tag[role].class-shape>child-shape`
 *
 * - `tag` is the lowercased tag name.
 * - `[role]` is the explicit role attribute, present only when declared — it is
 *   what tells a `div role="button"` apart from a layout `div`.
 * - `class-shape` is the normalized class tokens, sorted and capped at four.
 *   Sorting makes attribute order irrelevant; the cap stops a wall of utility
 *   classes from making every element unique, at the price of ignoring
 *   differences that appear only past the fourth token alphabetically.
 * - `child-shape` is the element children's tag names in document order, capped
 *   at five, or `#text` for a leaf with text. Two elements with the same class
 *   but different internals are different components, and this is the cheapest
 *   signal that says so.
 *
 * Variants stay distinct on purpose: `btn-primary` and `btn-secondary` are two
 * variants nested under kind `button`, which is what "4 button variants" means.
 */
function signatureFor(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role')?.trim().toLowerCase();

  const classes = [
    ...new Set(
      (el.getAttribute('class') ?? '')
        .split(/\s+/)
        .map(normalizeClassToken)
        .filter(Boolean),
    ),
  ]
    .sort()
    .slice(0, 4);

  const children = Array.from(el.children)
    .slice(0, 5)
    .map((child) => child.tagName.toLowerCase());
  const shape =
    children.length > 0
      ? children.join(',')
      : (el.textContent ?? '').trim()
        ? '#text'
        : '';

  return (
    tag +
    (role ? `[${role}]` : '') +
    (classes.length > 0 ? `.${classes.join('.')}` : '') +
    (shape ? `>${shape}` : '')
  );
}

/** The families kindFor names outright. Anything else is its tag name, which is
 * not evidence of a shared component — see `inventory`. Listed separately
 * because a recognized kind can equal its tag (`button`, `input`), so
 * `kind !== tag` alone cannot tell recognition from fallback. */
const RECOGNIZED_KINDS = new Set([
  'button',
  'card',
  'heading',
  'input',
  'link',
]);

/** Coarse family, from the strongest signal available: an explicit role beats
 * the tag, and the tag beats a class name. Unrecognized shapes report their tag
 * rather than a bucket like 'other', so a caller can still group them. */
function kindFor(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role')?.trim().toLowerCase() ?? '';
  const classes = (el.getAttribute('class') ?? '').toLowerCase();

  if (role === 'button' || tag === 'button') return 'button';
  if (
    tag === 'input' &&
    ['button', 'submit', 'reset'].includes(
      el.getAttribute('type')?.toLowerCase() ?? '',
    )
  ) {
    return 'button';
  }
  if (role) return role;
  if (/\bbtn\b|\bbutton\b/.test(classes)) return 'button';
  if (/\bcard\b|\btile\b/.test(classes)) return 'card';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return 'input';
  if (tag === 'a') return 'link';
  return tag;
}

/** Duplicated rather than imported from regions.ts, which keeps its own copy
 * private; the chains have to agree because `ComponentPattern.examples` is read
 * the same way `Region.domPath` is. */
function pathFromBody(el: Element): number[] {
  const path: number[] = [];
  let current: Element | null = el;
  while (current && current.parentElement) {
    const siblings = Array.from(current.parentElement.children);
    path.unshift(siblings.indexOf(current));
    if (current.parentElement === current.ownerDocument.body) break;
    current = current.parentElement;
  }
  return path;
}

/**
 * Instances grouped by kind, variants nested inside it, and the repetition
 * threshold applied to the kind.
 *
 * The one asymmetry: a fallback kind is a bare tag name, and a tag name says
 * nothing about two elements belonging to one component. `div.sidebar` and
 * `div.promo-banner` are not two variants of a `div` — reading them that way
 * would let a kind-level threshold admit exactly the layout noise the old
 * per-signature threshold suppressed. So a recognized family gets the
 * variant-set reading (two one-off button variants are two button variants),
 * while a fallback kind keeps the old evidence bar: the shape itself must
 * repeat. The cost is that a genuine one-off pair inside an unnamed family goes
 * unreported, which is the same thing the threshold has always traded away.
 */
function inventory(doc: Document): ComponentPattern[] {
  type Draft = {
    kind: string;
    recognized: boolean;
    variants: Map<string, ComponentVariant>;
  };

  const root = doc.body ?? doc.documentElement;
  if (!root) return [];

  const drafts = new Map<string, Draft>();
  for (const el of root.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    const identified =
      el.hasAttribute('class') ||
      el.hasAttribute('role') ||
      COMPONENT_TAGS.has(tag);
    if (!identified) continue;

    const kind = kindFor(el);
    let draft = drafts.get(kind);
    if (!draft) {
      draft = { kind, recognized: false, variants: new Map() };
      drafts.set(kind, draft);
    }
    // Accumulated rather than set once: one kind can be reached from several
    // tags (`<button>` and `div role="button"`), and recognition by any of them
    // is recognition of the family.
    draft.recognized ||= kind !== tag || RECOGNIZED_KINDS.has(kind);

    const signature = signatureFor(el);
    const variant = draft.variants.get(signature);
    if (variant) {
      variant.count += 1;
      if (variant.examples.length < MAX_EXAMPLES) {
        variant.examples.push(pathFromBody(el));
      }
    } else {
      draft.variants.set(signature, {
        signature,
        count: 1,
        examples: [pathFromBody(el)],
      });
    }
  }

  const patterns: ComponentPattern[] = [];
  for (const draft of drafts.values()) {
    const variants = [...draft.variants.values()]
      .filter((variant) => draft.recognized || variant.count >= MIN_INSTANCES)
      .sort(
        (a, b) => b.count - a.count || a.signature.localeCompare(b.signature),
      );
    const count = variants.reduce((total, variant) => total + variant.count, 0);
    if (count < MIN_INSTANCES) continue;
    patterns.push({
      kind: draft.kind,
      count,
      variants: variants.slice(0, MAX_VARIANTS),
    });
  }

  return patterns
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
    .slice(0, MAX_PATTERNS);
}

// ---------------------------------------------------------------------------
// stylesheet readers
// ---------------------------------------------------------------------------

const COMMENTS = /\/\*[\s\S]*?\*\//g;

/** At-rule preambles, dropped before the declaration scan so a media query's
 * `(max-width: 900px)` is never read as a container's `max-width`. */
const AT_RULE_PREAMBLE = /@[a-z-]+[^{;]*/gi;

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function pxFrom(raw: string): number | undefined {
  const match = /^(-?[\d.]+)(px|r?em)?$/.exec(collapse(raw).toLowerCase());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (Number.isNaN(amount)) return undefined;
  return match[2] === 'em' || match[2] === 'rem' ? amount * REM_PX : amount;
}

/** Declarations outside any at-rule preamble. Selectors leak through as
 * pseudo-class pairs (`a:hover`), which is harmless: every caller looks up
 * property names it chose. */
function* declarations(
  css: string,
): Generator<{ property: string; value: string }> {
  const body = css.replace(COMMENTS, '').replace(AT_RULE_PREAMBLE, '');
  const re = /([-a-z]+)\s*:\s*([^;{}]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    yield {
      property: (match[1] ?? '').toLowerCase(),
      value: collapse(match[2] ?? ''),
    };
  }
}

/** Text of the sheets that have any: a cross-origin sheet carries an href only,
 * which is why the caller warns about them. */
function readableText(styles: StyleSource[]): string[] {
  return styles
    .filter((style) => style.kind !== 'cross-origin')
    .map((style) => style.text);
}

function readFonts(sheets: string[]): DeclaredFont[] {
  type Draft = {
    family: string;
    sources: string[];
    weights: string[];
    styles: string[];
  };
  const byFamily = new Map<string, Draft>();

  const draftFor = (raw: string): Draft | undefined => {
    const family = collapse(raw).replace(/^['"]|['"]$/g, '');
    const key = family.toLowerCase();
    if (!family || GENERIC_FAMILIES.has(key) || family.includes('var(')) {
      return undefined;
    }
    const existing = byFamily.get(key);
    if (existing) return existing;
    const draft: Draft = { family, sources: [], weights: [], styles: [] };
    byFamily.set(key, draft);
    return draft;
  };

  const push = (into: string[], value: string): void => {
    if (value && !into.includes(value)) into.push(value);
  };

  for (const sheet of sheets) {
    const css = sheet.replace(COMMENTS, '');

    for (const face of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
      const block = face[1] ?? '';
      const family = /font-family\s*:\s*([^;}]+)/i.exec(block)?.[1];
      const draft = family === undefined ? undefined : draftFor(family);
      if (!draft) continue;
      const src = /src\s*:\s*([^;}]+)/i.exec(block)?.[1] ?? '';
      for (const url of src.matchAll(/url\(\s*['"]?([^'")]+)/g)) {
        push(draft.sources, collapse(url[1] ?? ''));
      }
      for (const weight of (
        /font-weight\s*:\s*([^;}]+)/i.exec(block)?.[1] ?? ''
      ).split(/\s+/)) {
        push(draft.weights, collapse(weight));
      }
      push(
        draft.styles,
        collapse(/font-style\s*:\s*([^;}]+)/i.exec(block)?.[1] ?? ''),
      );
    }

    // Stacks come second: an @font-face family already has its sources, and a
    // stack only ever adds a name.
    for (const { property, value } of declarations(css)) {
      if (property !== 'font-family' && property !== 'font') continue;
      for (const name of value.split(',')) draftFor(name);
    }
  }

  // Webfonts first: a family with sources is one the page shipped, and it is
  // what a reader of this report is looking for.
  return [...byFamily.values()].sort(
    (a, b) =>
      b.sources.length - a.sources.length || a.family.localeCompare(b.family),
  );
}

/** The rules directly inside a media block, excluding those in a nested
 * at-rule — the nested query is reported as its own breakpoint, so counting its
 * rules twice would overstate both. */
function countRules(body: string): number {
  let depth = 0;
  let preambleStart = 0;
  let rules = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === '{') {
      if (
        depth === 0 &&
        !body.slice(preambleStart, i).trimStart().startsWith('@')
      ) {
        rules += 1;
      }
      depth += 1;
    } else if (char === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) preambleStart = i + 1;
    }
  }
  return rules;
}

/**
 * Media queries, deduplicated across sheets by their written text. Nested
 * queries are reported per level rather than flattened into a combined
 * condition, because a flattened `A and B` is a query the author never wrote
 * and could not be matched back to the source.
 *
 * Only simple `min-width`/`max-width` bounds are parsed. A range-syntax query
 * (`(400px <= width < 800px)`) still appears, just without numeric bounds.
 */
function readBreakpoints(sheets: string[]): Breakpoint[] {
  const byQuery = new Map<string, Breakpoint>();

  for (const sheet of sheets) {
    const css = sheet.replace(COMMENTS, '');
    const re = /@media\b([^{]*)\{/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(css)) !== null) {
      const bodyStart = match.index + match[0].length;
      let depth = 1;
      let end = css.length;
      for (let i = bodyStart; i < css.length; i += 1) {
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const query = collapse(match[1] ?? '');
      // Resuming inside the body rather than past it is what finds nested
      // queries without a second recursive pass.
      const ruleCount = countRules(css.slice(bodyStart, end));

      // Dedup key ignores spacing so `(min-width:600px)` and
      // `(min-width: 600px)` are one breakpoint, not two.
      const key = query.replace(/\s+/g, '').toLowerCase();
      const existing = byQuery.get(key);
      if (existing) {
        existing.ruleCount += ruleCount;
        continue;
      }
      const minWidth = pxFrom(
        /\(\s*min-width\s*:\s*([^)]+)\)/i.exec(query)?.[1] ?? '',
      );
      const maxWidth = pxFrom(
        /\(\s*max-width\s*:\s*([^)]+)\)/i.exec(query)?.[1] ?? '',
      );
      byQuery.set(key, {
        query,
        ...(minWidth === undefined ? {} : { minWidth }),
        ...(maxWidth === undefined ? {} : { maxWidth }),
        ruleCount,
      });
    }
  }

  // Width-bounded queries ascending, because that is the order a design system
  // is authored in; the bound-less ones (print, orientation) sort after.
  return [...byQuery.values()].sort((a, b) => {
    const left = a.minWidth ?? a.maxWidth;
    const right = b.minWidth ?? b.maxWidth;
    if (left !== undefined && right !== undefined) return left - right;
    if (left !== undefined) return -1;
    if (right !== undefined) return 1;
    return a.query.localeCompare(b.query);
  });
}

const GAP_PROPERTIES = new Set(['gap', 'grid-gap', 'row-gap', 'column-gap']);

function readGrid(sheets: string[]): GridInference {
  const templateColumns: Record<string, number> = {};
  const gaps: Record<string, number> = {};
  const containerWidths = new Set<number>();

  for (const sheet of sheets) {
    for (const { property, value } of declarations(sheet)) {
      if (
        property === 'grid-template-columns' ||
        property === 'grid-template'
      ) {
        const key = collapse(value).toLowerCase();
        if (key) templateColumns[key] = (templateColumns[key] ?? 0) + 1;
      } else if (GAP_PROPERTIES.has(property)) {
        // A shorthand `gap: 16px 24px` is two decisions, tallied separately —
        // the same way tokens.ts tallies each spacing side on its own.
        for (const part of value.split(/\s+/)) {
          const length = normalizeLength(part);
          if (length) gaps[length] = (gaps[length] ?? 0) + 1;
        }
      } else if (property === 'max-width') {
        const px = pxFrom(value);
        if (px !== undefined && px >= MIN_CONTAINER_WIDTH) {
          containerWidths.add(px);
        }
      }
    }
  }

  return {
    templateColumns,
    gaps,
    containerWidths: [...containerWidths].sort((a, b) => a - b),
  };
}

export const extractDesign: ExtractorMap['design'] = (
  ctx: ExtractorContext,
) => {
  const unreadable = ctx.ir.styles
    .filter((style) => style.kind === 'cross-origin')
    .map((style) => style.href);
  if (unreadable.length > 0) {
    ctx.warn({
      reason: 'cross-origin stylesheets carry no text',
      detail: `breakpoints, grid, and declared fonts skip ${unreadable.join(', ')}`,
    });
  }

  const sheets = readableText(ctx.ir.styles);
  return {
    components: inventory(ctx.doc),
    fonts: readFonts(sheets),
    breakpoints: readBreakpoints(sheets),
    grid: readGrid(sheets),
  };
};
