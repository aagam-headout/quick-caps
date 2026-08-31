import { flattenRegions, type FlatRegion } from '../distill.js';
import type {
  ContentReport,
  ContentSplit,
  ExtractorContext,
  ExtractorMap,
  HeadingNode,
  MediaInventory,
  MediaItem,
  OutlineViolation,
} from './types.js';

/** Standard adult prose rate. A single number is the honest resolution here:
 * the alternative is per-language rates nobody can validate from one page. */
const WORDS_PER_MINUTE = 200;

/** Elements whose text is markup, telemetry, or a fallback nobody reads —
 * counting them would make a script-heavy page look like an essay. */
const NON_PROSE_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'canvas',
  'object',
  'head',
  'title',
]);

function proseText(el: Element): string {
  let text = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3) {
      text += ` ${node.textContent ?? ''}`;
      continue;
    }
    if (node.nodeType !== 1) continue;
    const child = node as Element;
    if (NON_PROSE_TAGS.has(child.tagName.toLowerCase())) continue;
    if (child.getAttribute('aria-hidden') === 'true') continue;
    if (child.hasAttribute('hidden')) continue;
    text += ` ${proseText(child)}`;
  }
  return text;
}

const CJK =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu;

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** CJK is counted per character rather than per whitespace run: a Japanese
 * paragraph has no spaces, and counting it as one word would report a
 * thousand-character page as a one-second read. */
function countWords(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  return cjk + (text.replace(CJK, ' ').match(WORD)?.length ?? 0);
}

function collapse(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// language
// ---------------------------------------------------------------------------

/** `fr_FR` is what og:locale spells; BCP 47 wants `fr-FR`. */
function normalizeTag(raw: string): string {
  return collapse(raw).replace(/_/g, '-');
}

function declaredLanguage(doc: Document): string | undefined {
  const attr = doc.documentElement?.getAttribute('lang');
  if (attr && collapse(attr)) return normalizeTag(attr);
  for (const meta of doc.querySelectorAll('meta[content]')) {
    const key = (
      meta.getAttribute('http-equiv') ??
      meta.getAttribute('property') ??
      meta.getAttribute('name') ??
      ''
    ).toLowerCase();
    if (key !== 'content-language' && key !== 'og:locale') continue;
    const value = meta.getAttribute('content');
    // Takes only the first of a comma-separated list: a page declaring several
    // content languages has not told us which one this document is in.
    const first = value?.split(',')[0];
    if (first && collapse(first)) return normalizeTag(first);
  }
  return undefined;
}

/** Kana before Han, because Han alone cannot separate Japanese from Chinese
 * while a single kana settles it. */
const SCRIPT_LANGUAGES: Array<[RegExp, string]> = [
  [/[\u3040-\u309f\u30a0-\u30ff]/gu, 'ja'],
  [/[\uac00-\ud7af]/gu, 'ko'],
  [/[\u4e00-\u9fff]/gu, 'zh'],
  [/[\u0400-\u04ff]/gu, 'ru'],
  [/[\u0600-\u06ff]/gu, 'ar'],
  [/[\u0900-\u097f]/gu, 'hi'],
  [/[\u0590-\u05ff]/gu, 'he'],
  [/[\u0370-\u03ff]/gu, 'el'],
  [/[\u0e00-\u0e7f]/gu, 'th'],
];

/** Function words only. They are the cheapest signal that survives topic
 * change, and a bare-bones table beats a dependency for a value the caller
 * only ever sees when the page declared nothing. */
const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'for', 'with', 'it'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'con', 'se'],
  fr: ['le', 'la', 'les', 'des', 'et', 'est', 'pour', 'dans', 'avec', 'que'],
  de: ['der', 'die', 'das', 'und', 'ist', 'mit', 'nicht', 'den', 'ein', 'zu'],
  pt: ['o', 'a', 'de', 'que', 'e', 'em', 'para', 'com', 'uma', 'no'],
  it: ['il', 'la', 'di', 'che', 'e', 'per', 'con', 'non', 'una', 'del'],
};

const SCRIPT_MIN_HITS = 4;
const STOPWORD_MIN_HITS = 3;

function detectLanguage(text: string): string | undefined {
  for (const [pattern, language] of SCRIPT_LANGUAGES) {
    if ((text.match(pattern)?.length ?? 0) >= SCRIPT_MIN_HITS) return language;
  }

  const tokens = text.toLowerCase().match(WORD) ?? [];
  if (tokens.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const token of tokens) {
    for (const [language, words] of Object.entries(STOPWORDS)) {
      if (words.includes(token)) {
        counts.set(language, (counts.get(language) ?? 0) + 1);
      }
    }
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [best, runnerUp] = ranked;
  if (!best || best[1] < STOPWORD_MIN_HITS) return undefined;
  // A tie is a non-answer: these vocabularies overlap (`la`, `de`, `que`), and
  // reporting either half of a tie would be a guess dressed as a detection.
  if (runnerUp && runnerUp[1] === best[1]) return undefined;
  return best[0];
}

// ---------------------------------------------------------------------------
// outline
// ---------------------------------------------------------------------------

const HEADING_LEVEL: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

const ARIA_HEADING_DEFAULT_LEVEL = 2;

function headingLevel(el: Element): number | undefined {
  const byTag = HEADING_LEVEL[el.tagName.toLowerCase()];
  if (byTag !== undefined) return byTag;
  if ((el.getAttribute('role') ?? '').toLowerCase() !== 'heading') {
    return undefined;
  }
  const declared = Number(el.getAttribute('aria-level'));
  return Number.isInteger(declared) && declared >= 1 && declared <= 6
    ? declared
    : ARIA_HEADING_DEFAULT_LEVEL;
}

/**
 * Child-index chain from body, the same addressing Region.domPath uses. Not
 * shared with regions.ts on purpose: that copy is private to the region
 * builder, and headings and media are not regions — an image below the region
 * depth cap still needs a path a caller can relocate it by.
 */
function pathFromBody(el: Element): number[] {
  const path: number[] = [];
  let current: Element | null = el;
  while (current?.parentElement) {
    const siblings = Array.from(current.parentElement.children);
    path.unshift(siblings.indexOf(current));
    if (current.parentElement === current.ownerDocument.body) break;
    current = current.parentElement;
  }
  return path;
}

function readOutline(doc: Document): HeadingNode[] {
  const headings: HeadingNode[] = [];
  for (const el of doc.querySelectorAll(
    'h1, h2, h3, h4, h5, h6, [role="heading"]',
  )) {
    const level = headingLevel(el);
    if (level === undefined) continue;
    headings.push({
      level,
      text: collapse(el.textContent ?? ''),
      domPath: pathFromBody(el),
    });
  }
  return headings;
}

function outlineViolations(outline: HeadingNode[]): OutlineViolation[] {
  const violations: OutlineViolation[] = [];
  let previous = 0;
  let h1Count = 0;

  outline.forEach((heading, index) => {
    if (heading.level === 1) {
      h1Count += 1;
      if (h1Count > 1) {
        violations.push({
          kind: 'multiple-h1',
          headingIndex: index,
          detail: `h1 number ${h1Count}: "${heading.text}"`,
        });
      }
    }
    // Only a gap between two headings is a skip. A document that opens at h2
    // is a missing h1, reported once below rather than as a skip from nothing.
    if (previous > 0 && heading.level > previous + 1) {
      violations.push({
        kind: 'skipped-level',
        headingIndex: index,
        detail: `h${heading.level} follows h${previous}`,
      });
    }
    previous = heading.level;
  });

  if (outline.length > 0 && h1Count === 0) {
    violations.unshift({
      kind: 'missing-h1',
      detail: `the outline starts at h${outline[0]?.level ?? 0}`,
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

/**
 * Whether anything on this page was actually laid out. A static session has no
 * layout engine, so every box is 0x0 and every textDensity is 0 — which is not
 * a page of collapsed elements but a page nobody measured, and the two demand
 * opposite treatment: the content split must ignore geometry rather than
 * exclude every region, and the media inventory must omit `displayed` rather
 * than report a zero it did not measure.
 *
 * Probed once per page and passed down, so those two consumers can never
 * disagree about which kind of page this is.
 */
function isMeasured(flat: FlatRegion[]): boolean {
  return flat.some((entry) => entry.region.box.w * entry.region.box.h > 0);
}

// ---------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------

function firstSrcsetCandidate(value: string | null): string | undefined {
  const first = value?.split(',')[0]?.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : undefined;
}

/** What the element would actually load, in the order a browser resolves it,
 * with the JS lazy-loader attributes last — a `data-src` is the real source
 * only when nothing else claimed the slot. */
function mediaSource(el: Element): string {
  const direct = el.getAttribute('src');
  if (direct && collapse(direct)) return collapse(direct);

  const fromSrcset = firstSrcsetCandidate(el.getAttribute('srcset'));
  if (fromSrcset) return fromSrcset;

  const child = el.querySelector('source[src], source[srcset]');
  const fromChild =
    child?.getAttribute('src') ??
    firstSrcsetCandidate(child?.getAttribute('srcset') ?? null);
  if (fromChild && collapse(fromChild)) return collapse(fromChild);

  return (
    firstSrcsetCandidate(el.getAttribute('data-srcset')) ??
    firstSrcsetCandidate(el.getAttribute('data-src')) ??
    ''
  );
}

function absolutize(raw: string, base: string): string {
  if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
  try {
    return new URL(raw, base).href;
  } catch {
    // Left as written. An unparseable src is still worth reporting — the alt
    // and lazy findings for that element do not depend on resolving it.
    return raw;
  }
}

const DATA_URI_MIME = /^data:[a-z]+\/([a-z0-9.+-]+)/i;
const EXTENSION = /\.([a-z0-9]{2,5})$/i;

function formatOf(src: string, el: Element): string | undefined {
  const path = src.split(/[?#]/)[0] ?? '';
  const extension = EXTENSION.exec(path);
  if (extension?.[1]) return extension[1].toLowerCase();

  const dataUri = DATA_URI_MIME.exec(src);
  if (dataUri?.[1]) return dataUri[1].toLowerCase();

  const declared =
    el.getAttribute('type') ??
    el.querySelector('source[type]')?.getAttribute('type') ??
    '';
  const subtype = declared.split('/')[1]?.split(';')[0];
  return subtype ? subtype.toLowerCase() : undefined;
}

function isLazy(el: Element): boolean {
  if ((el.getAttribute('loading') ?? '').toLowerCase() === 'lazy') return true;
  if (el.hasAttribute('data-src') || el.hasAttribute('data-srcset'))
    return true;
  // A video the page told the browser not to preload is deferred by the same
  // intent as a lazy image, even though the attribute is spelled differently.
  return (el.getAttribute('preload') ?? '').toLowerCase() === 'none';
}

/** `alt` is an img-only attribute, but a video with no accessible name is the
 * same reporting gap, so its aria-label stands in for one. */
function altTextOf(el: Element): string | null {
  if (el.tagName.toLowerCase() === 'img') return el.getAttribute('alt');
  return el.getAttribute('aria-label') ?? el.getAttribute('title');
}

function share(part: number, total: number): number {
  return total === 0 ? 0 : Number((part / total).toFixed(4));
}

function readMedia(
  ctx: ExtractorContext,
  boxes: Map<string, MediaItem['displayed']>,
  base: string,
  measured: boolean,
): MediaInventory {
  const items: MediaItem[] = [];
  const formats: Record<string, number> = {};
  let withAlt = 0;
  let lazyCount = 0;
  let withoutBox = 0;

  for (const el of ctx.doc.querySelectorAll('img, video, audio')) {
    const src = absolutize(mediaSource(el), base);
    const alt = altTextOf(el);
    const format = formatOf(src, el);
    const lazy = isLazy(el);
    // A box is a measurement only where something measured. On an unmeasured
    // page every box is 0x0, and reporting that would make a genuinely
    // collapsed image — a real finding — indistinguishable from one nobody
    // sized, for any consumer that averages, sorts, or filters on the field.
    const displayed = measured
      ? boxes.get(pathFromBody(el).join(','))
      : undefined;

    if (alt !== null && collapse(alt).length > 0) withAlt += 1;
    if (lazy) lazyCount += 1;
    if (format) formats[format] = (formats[format] ?? 0) + 1;
    if (measured && displayed === undefined) withoutBox += 1;

    items.push({
      src,
      ...(alt === null ? {} : { alt }),
      ...(format === undefined ? {} : { format }),
      lazy,
      ...(displayed === undefined ? {} : { displayed }),
    });
  }

  // Two different absences, so two different sentences — and never both, since
  // an unmeasured page has no per-element gap to report on top of the page-wide
  // one. Once per page either way: one warning per image would bury the fact
  // that the cause is the same single thing.
  if (items.length > 0 && !measured) {
    ctx.warn({
      reason: 'displayed size unavailable: the page was not laid out',
      detail: `this collection has no geometry at all, so displayed size is omitted from all ${items.length} media item(s) rather than reported as a zero nobody measured`,
    });
  } else if (withoutBox > 0) {
    ctx.warn({
      reason: 'displayed size unavailable for some media',
      detail: `${withoutBox} of ${items.length} elements were not found in the region tree, so only their src, alt, format and lazy state are reported`,
    });
  }

  return {
    items,
    altCoverage: share(withAlt, items.length),
    formats,
    lazyShare: share(lazyCount, items.length),
  };
}

// ---------------------------------------------------------------------------
// main versus boilerplate
// ---------------------------------------------------------------------------

/** Roles that declare content outright. `article` counts because a page of
 * articles has no `main` more often than it should. */
const MAIN_ROLES = new Set(['main', 'article']);

/** Roles that are boilerplate by definition rather than by measurement. A
 * `form` is deliberately not here: on a signup page the form is the content. */
const BOILERPLATE_ROLES = new Set([
  'banner',
  'navigation',
  'contentinfo',
  'complementary',
  'search',
]);

/** How much of the best candidate's text a deeper region must still hold to
 * be preferred over it — the threshold that walks an inference down past
 * layout wrappers into the block that actually holds the prose. */
const DRILL_DOWN_RATIO = 0.6;

const LANDMARK_BASE = 0.75;
const LANDMARK_SHARE_WEIGHT = 0.2;
const INFERRED_BASE = 0.25;
const INFERRED_SHARE_WEIGHT = 0.35;
/** Text exists but nothing could be called main: a floor, not a split. */
const UNIDENTIFIED_CONFIDENCE = 0.1;

/**
 * Classifies the outermost region of each landmarked subtree, then — only if
 * no landmark declared main — infers one from the fields regions carry.
 *
 * Confidence is a function of two things and nothing else, so a reviewer can
 * predict it:
 *
 * - how main was found. A declared `main`/`article` starts at 0.75; an
 *   inference from text mass and geometry starts at 0.25 and can never reach
 *   the declared floor, because the page never said so.
 * - `mainShare`, main's share of the page's characters, worth up to 0.2 on top
 *   of a declared landmark and up to 0.35 on top of an inference. A small
 *   declared main (a one-line `main` under a six-link nav) still scores high:
 *   the split is right, the page is just mostly chrome. A large *inferred*
 *   main earns more than a small one, since text mass is the only evidence
 *   there was.
 *
 * A page with no text at all scores 0 — there is no split to be confident
 * about — and a page whose text is entirely in boilerplate landmarks scores
 * the 0.1 floor and warns.
 */
function splitContent(
  ctx: ExtractorContext,
  flat: FlatRegion[],
  body: Element,
  measured: boolean,
): ContentSplit {
  const classified = new Set<number>();
  const mainRegionIds: number[] = [];
  const boilerplateRegionIds: number[] = [];

  // flat is pre-order, so a parent is always seen before its children and the
  // ancestor check below records the outermost region of a subtree only.
  for (const entry of flat) {
    if (entry.parentIds.some((id) => classified.has(id))) continue;
    const { role, id } = { role: entry.region.role, id: entry.region.id };
    if (MAIN_ROLES.has(role)) {
      mainRegionIds.push(id);
      classified.add(id);
    } else if (BOILERPLATE_ROLES.has(role)) {
      boilerplateRegionIds.push(id);
      classified.add(id);
    }
  }

  const totalChars = flat
    .filter((entry) => entry.depth === 1)
    .reduce((sum, entry) => sum + entry.region.textLength, 0);
  const landmarked = mainRegionIds.length > 0;

  if (!landmarked) {
    const boilerplate = new Set(boilerplateRegionIds);
    const candidates = flat.filter(
      (entry) =>
        !boilerplate.has(entry.region.id) &&
        !entry.parentIds.some((id) => boilerplate.has(id)) &&
        entry.region.textLength > 0 &&
        // A zero-area box is not laid out, so its text is not what a reader
        // sees however dense it looks — but only a measured collection can
        // tell that apart from having never been measured at all.
        (!measured || entry.region.box.w * entry.region.box.h > 0),
    );
    const heaviest = candidates.reduce<FlatRegion | undefined>(
      (best, entry) =>
        best === undefined || entry.region.textLength > best.region.textLength
          ? entry
          : best,
      undefined,
    );
    if (heaviest) {
      const floor = heaviest.region.textLength * DRILL_DOWN_RATIO;
      // Deepest region still holding essentially all of that text: the wrapper
      // and the block inside it carry the same prose, and the block is the
      // more useful answer. Ties break on density, which distinguishes a
      // content block from the shell around it where geometry exists, and is a
      // uniform 0 where it does not — leaving document order to break the tie,
      // which is the only ordering an unmeasured page offers.
      const chosen = candidates
        .filter((entry) => entry.region.textLength >= floor)
        .reduce((best, entry) =>
          entry.depth > best.depth ||
          (entry.depth === best.depth &&
            entry.region.textDensity > best.region.textDensity)
            ? entry
            : best,
        );
      mainRegionIds.push(chosen.region.id);
    }
  }

  const mainChars = flat
    .filter((entry) => mainRegionIds.includes(entry.region.id))
    .reduce((sum, entry) => sum + entry.region.textLength, 0);
  const mainShare = totalChars === 0 ? 0 : mainChars / totalChars;

  let unresolved = 0;
  let mainWordCount = 0;
  for (const id of mainRegionIds) {
    const region = flat.find((entry) => entry.region.id === id)?.region;
    const el = region && elementAt(body, region.domPath);
    if (!el) {
      unresolved += 1;
      continue;
    }
    mainWordCount += countWords(proseText(el));
  }
  if (unresolved > 0) {
    ctx.warn({
      reason: 'main word count is partial',
      detail: `${unresolved} main region(s) could not be relocated in the document, so their words are missing from mainWordCount`,
    });
  }

  if (totalChars > 0 && mainRegionIds.length === 0) {
    ctx.warn({
      reason: 'no main content region identified',
      detail:
        boilerplateRegionIds.length > 0
          ? 'every region carrying text sits inside a boilerplate landmark, so the split reports boilerplate only'
          : 'no landmark declared main, and every region carrying text has a zero-area box, so the text this page has is not laid out and cannot be its main content',
    });
  }

  const confidence =
    totalChars === 0
      ? 0
      : mainRegionIds.length === 0
        ? UNIDENTIFIED_CONFIDENCE
        : landmarked
          ? LANDMARK_BASE + LANDMARK_SHARE_WEIGHT * mainShare
          : INFERRED_BASE + INFERRED_SHARE_WEIGHT * mainShare;

  return {
    mainRegionIds,
    boilerplateRegionIds,
    mainWordCount,
    confidence: Number(confidence.toFixed(2)),
  };
}

function elementAt(body: Element, domPath: number[]): Element | undefined {
  let current: Element | undefined = body;
  for (const index of domPath) {
    current = current?.children[index];
    if (current === undefined) return undefined;
  }
  return current;
}

// ---------------------------------------------------------------------------

function emptyReport(): ContentReport {
  return {
    wordCount: 0,
    readingTimeMinutes: 0,
    outline: [],
    outlineViolations: [],
    media: { items: [], altCoverage: 0, formats: {}, lazyShare: 0 },
    split: {
      mainRegionIds: [],
      boilerplateRegionIds: [],
      mainWordCount: 0,
      confidence: 0,
    },
  };
}

/**
 * Content quality from the IR and the parsed document alone. Every finding
 * here is Stage 1 of the extraction spec: `ctx.computedStyle` is deliberately
 * never read, because nothing in this report needs it — image *natural* size,
 * fonts actually loaded, overlays, and contrast are Stage 2 questions that the
 * report type has no field for yet.
 */
export const extractContent: ExtractorMap['content'] = (ctx) => {
  const { body } = ctx.doc;
  if (!body) {
    ctx.warn({
      reason: 'the document has no body',
      detail: 'no words, headings, media, or content split could be derived',
    });
    return emptyReport();
  }

  const text = proseText(body);
  const wordCount = countWords(text);
  const language = declaredLanguage(ctx.doc) ?? detectLanguage(text);

  const flat = flattenRegions(ctx.ir.regions);
  const boxes = new Map<string, MediaItem['displayed']>(
    flat.map((entry) => [
      entry.region.domPath.join(','),
      { w: entry.region.box.w, h: entry.region.box.h },
    ]),
  );
  const base =
    ctx.doc.querySelector('base[href]')?.getAttribute('href') ??
    ctx.ir.metadata.url;

  const outline = readOutline(ctx.doc);
  const measured = isMeasured(flat);

  return {
    wordCount,
    readingTimeMinutes: Math.round((wordCount / WORDS_PER_MINUTE) * 10) / 10,
    ...(language === undefined ? {} : { language }),
    outline,
    outlineViolations: outlineViolations(outline),
    media: readMedia(ctx, boxes, base, measured),
    split: splitContent(ctx, flat, body, measured),
  };
};
