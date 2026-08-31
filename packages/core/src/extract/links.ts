import type { Region } from '../ir.js';
import type { ExtractorMap, LinkEntry, LinkZone } from './types.js';

/** Landmark roles that answer "where on the page is this link". Roles absent
 * here — 'generic', 'list', 'region' from a bare <section> — say nothing about
 * zone, so the lookup keeps climbing past them rather than reporting a zone
 * the markup never claimed. A <header>'s links are navigation for a crawler's
 * purposes even when no <nav> wraps them, which is why 'banner' maps to nav. */
const ZONE_BY_ROLE: Record<string, LinkZone> = {
  navigation: 'nav',
  banner: 'nav',
  contentinfo: 'footer',
  main: 'content',
  article: 'content',
  complementary: 'aside',
};

/** Long enough for a real sentence of anchor text, short enough that a card
 * wrapped entirely in an <a> cannot dominate the report. */
const TEXT_CAP = 200;

function collapse(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length > TEXT_CAP ? `${flat.slice(0, TEXT_CAP - 1)}…` : flat;
}

/** Icon-only anchors are common and carry no text node, so the labels
 * accessibility already requires stand in for one. */
function anchorText(el: Element): string {
  const own = collapse(el.textContent ?? '');
  if (own) return own;
  const fallback =
    el.getAttribute('aria-label') ??
    el.getAttribute('title') ??
    el.querySelector('img[alt]')?.getAttribute('alt') ??
    '';
  return collapse(fallback);
}

function relTokens(el: Element): string[] {
  const declared = (el.getAttribute('rel') ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return [...new Set(declared)];
}

/**
 * Walks a Region's domPath back down to its element. The IR's paths are the
 * only link between a region's role and a DOM node, and resolving them this
 * way — rather than recomputing paths from each anchor upward — keeps
 * regions.ts's wrapper-collapsing rules the single source of truth.
 */
function elementAt(doc: Document, path: number[]): Element | null {
  let el: Element | null = doc.body;
  for (const index of path) {
    el = el?.children[index] ?? null;
    if (!el) return null;
  }
  return el === doc.body ? null : el;
}

/** Element to zone, for every region that claims a landmark role. Regions are
 * walked parents-first and children overwrite, but the lookup below reads
 * upward from the anchor, so nesting resolves to the innermost landmark: a
 * <nav> inside a <footer> is nav, not footer. */
function zonesByElement(
  doc: Document,
  regions: Region[],
  into: Map<Element, LinkZone>,
): Map<Element, LinkZone> {
  for (const region of regions) {
    const zone = ZONE_BY_ROLE[region.role];
    if (zone) {
      const el = elementAt(doc, region.domPath);
      if (el) into.set(el, zone);
    }
    zonesByElement(doc, region.children, into);
  }
  return into;
}

/** Link handles the IR already issued, keyed by element. A region only records
 * actions for its direct children, so a link inside a collapsed wrapper has no
 * handle — reported as absent rather than invented. */
function handlesByElement(
  doc: Document,
  regions: Region[],
  into: Map<Element, number>,
): Map<Element, number> {
  for (const region of regions) {
    for (const action of region.actions) {
      if (action.type !== 'link') continue;
      const el = elementAt(doc, action.domPath);
      if (el) into.set(el, action.id);
    }
    handlesByElement(doc, region.children, into);
  }
  return into;
}

/**
 * The link graph, in the shape a crawler frontier needs: every anchor
 * classified internal or external against the page origin, placed in a page
 * zone by the landmark region enclosing it, and tallied per outbound host.
 * Duplicate hrefs are kept as separate entries on purpose — the same target in
 * a nav and in a footer are two different facts about the page, and collapsing
 * them would lose the zone the crawler uses to prioritize.
 */
export const extractLinks: ExtractorMap['links'] = (ctx) => {
  const { doc, ir } = ctx;
  const anchors = [...doc.querySelectorAll('a[href], area[href]')];
  // Entry and anchor travel together: a skipped href shifts every later index,
  // so the zone pass cannot re-derive the pairing from position alone.
  const found: Array<{ entry: LinkEntry; anchor: Element }> = [];
  const links: LinkEntry[] = [];
  const byHost: Record<string, number> = {};
  let internalCount = 0;

  // Returned before anything is resolved, so a link-less page costs nothing
  // and warns about nothing — including about a page url it never used.
  if (anchors.length === 0) {
    return { links, internalCount: 0, externalCount: 0, byHost };
  }

  const pageUrl = ir.metadata.url;
  // A <base href> may itself be relative, so it is resolved against the page
  // url before being used as one. Falling back to the page url matches what
  // the browser does with a base it cannot parse.
  const declaredBase = doc.querySelector('base[href]')?.getAttribute('href');
  let base: string | null = null;
  try {
    base = declaredBase
      ? new URL(declaredBase, pageUrl).href
      : new URL(pageUrl).href;
  } catch {
    // Same stance collect.ts takes for stylesheets: an unparseable page url
    // does not abandon the work, it only means origin cannot be judged.
    ctx.warn({
      url: pageUrl,
      reason: 'page url could not be parsed',
      detail:
        'hrefs are reported as written and nothing is treated as internal',
    });
  }
  // 'null' is what URL.origin gives an opaque origin (a data: page), and two
  // opaque origins are never the same origin.
  const pageOrigin = base === null ? null : new URL(base).origin;
  const comparableOrigin = pageOrigin === 'null' ? null : pageOrigin;

  for (const anchor of anchors) {
    const raw = (anchor.getAttribute('href') ?? '').trim();
    const entry: LinkEntry = {
      href: raw,
      text: anchorText(anchor),
      internal: false,
      zone: 'unknown',
      rel: relTokens(anchor),
      host: '',
    };

    if (base !== null) {
      let resolved: URL;
      try {
        resolved = new URL(raw, base);
      } catch {
        // Normal on the real web — a typo'd or template-mangled href. Warned
        // and dropped, because an href that resolves nowhere is not a frontier
        // entry and reporting it as one would mislead the crawler.
        ctx.warn({
          url: raw,
          reason: 'unresolvable href',
          detail: `anchor text: ${entry.text || '(none)'}`,
        });
        continue;
      }
      entry.href = resolved.href;
      // Empty for mailto:, tel:, and javascript: — they have no host, and a
      // scheme the crawler cannot follow must not enter the outbound tally.
      entry.host = resolved.host;
      entry.internal =
        comparableOrigin !== null && resolved.origin === comparableOrigin;
    }

    found.push({ entry, anchor });
    if (entry.internal) internalCount += 1;
    else if (entry.host) byHost[entry.host] = (byHost[entry.host] ?? 0) + 1;
  }

  // Zone and handle come from a second pass so the two element maps are built
  // once rather than per anchor.
  const zones = zonesByElement(doc, ir.regions, new Map());
  const handles = handlesByElement(doc, ir.regions, new Map());
  for (const { entry, anchor } of found) {
    const handle = handles.get(anchor);
    if (handle !== undefined) entry.handle = handle;
    for (let el: Element | null = anchor; el !== null; el = el.parentElement) {
      const zone = zones.get(el);
      if (zone) {
        entry.zone = zone;
        break;
      }
    }
    links.push(entry);
  }

  return {
    links,
    internalCount,
    externalCount: links.length - internalCount,
    byHost,
  };
};
