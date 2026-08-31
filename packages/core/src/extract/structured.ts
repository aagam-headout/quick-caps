import type {
  ExtractorContext,
  ExtractorMap,
  FeedLink,
  JsonLdNode,
  MicrodataItem,
  RdfaItem,
  SeoReport,
  SocialPreview,
  StructuredReport,
} from './types.js';

const tokens = (value: string | null): string[] =>
  value?.trim().split(/\s+/).filter(Boolean) ?? [];

const text = (el: Element): string =>
  (el.textContent ?? '').replace(/\s+/g, ' ').trim();

const children = (el: Element): Element[] => Array.from(el.children);

/**
 * Absolutizes a declared url, or hands it back as written when it will not
 * resolve. Neither dropped nor warned about: a caller can see an unresolved
 * value for what it is, and a page full of odd hrefs would bury the warnings
 * that matter.
 */
function resolve(raw: string | null, base: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return trimmed;
  }
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

function flattenJsonLd(value: unknown, out: JsonLdNode[]): void {
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLd(item, out);
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  const node = value as JsonLdNode;
  if (node['@graph'] === undefined) {
    out.push(node);
    return;
  }

  // A @graph is a container, so its members are the nodes and the wrapper is
  // not — unless the wrapper declared something of its own alongside it, in
  // which case it is both and survives with the container key removed.
  const wrapper: JsonLdNode = {};
  let declarations = 0;
  for (const [key, member] of Object.entries(node)) {
    if (key === '@graph') continue;
    wrapper[key] = member;
    if (key !== '@context') declarations += 1;
  }
  if (declarations > 0) out.push(wrapper);
  // Recursive because a @graph holding a @graph is legal and does occur.
  flattenJsonLd(node['@graph'], out);
}

function readJsonLd(ctx: ExtractorContext): JsonLdNode[] {
  const nodes: JsonLdNode[] = [];
  let block = 0;

  for (const script of Array.from(ctx.doc.querySelectorAll('script'))) {
    // Prefix-matched rather than compared: a charset parameter on the type is
    // common and does not make the block something other than JSON-LD.
    const type = script.getAttribute('type')?.trim().toLowerCase() ?? '';
    if (!type.startsWith('application/ld+json')) continue;

    block += 1;
    const source = script.textContent?.trim() ?? '';
    // An empty block is a template that rendered nothing, not a parse failure
    // worth telling the caller about.
    if (!source) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      ctx.warn({
        reason: 'malformed JSON-LD block',
        detail: `block ${block}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const before = nodes.length;
    flattenJsonLd(parsed, nodes);
    if (nodes.length === before) {
      ctx.warn({
        reason: 'JSON-LD block declared no node',
        detail: `block ${block}: parsed as ${parsed === null ? 'null' : typeof parsed}`,
      });
    }
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Microdata
// ---------------------------------------------------------------------------

/** Where each element type keeps a url-valued property. */
const URL_ATTRIBUTE: Record<string, string> = {
  a: 'href',
  area: 'href',
  link: 'href',
  audio: 'src',
  embed: 'src',
  iframe: 'src',
  img: 'src',
  source: 'src',
  track: 'src',
  video: 'src',
  object: 'data',
};

function microdataValue(el: Element, base: string): string {
  const tag = el.tagName.toLowerCase();
  const urlAttribute = URL_ATTRIBUTE[tag];
  // Microdata defines a url-valued property as the resolved url, which also
  // lets a caller compare it against a canonical or a JSON-LD @id directly.
  if (urlAttribute) return resolve(el.getAttribute(urlAttribute), base) ?? '';
  if (tag === 'meta') return el.getAttribute('content')?.trim() ?? '';
  if (tag === 'data' || tag === 'meter') {
    return el.getAttribute('value')?.trim() ?? '';
  }
  if (tag === 'time') return el.getAttribute('datetime')?.trim() ?? text(el);
  return text(el);
}

function readMicrodataItem(scope: Element, base: string): MicrodataItem {
  const item: MicrodataItem = {
    types: tokens(scope.getAttribute('itemtype')),
    properties: {},
  };
  const id = scope.getAttribute('itemid')?.trim();
  if (id) item.id = id;

  const visit = (el: Element): void => {
    for (const child of children(el)) {
      const names = tokens(child.getAttribute('itemprop'));
      const nested = child.hasAttribute('itemscope');
      if (names.length > 0) {
        const value = nested
          ? readMicrodataItem(child, base)
          : microdataValue(child, base);
        for (const name of names) (item.properties[name] ??= []).push(value);
      }
      // A nested scope owns its own subtree; descending into it here would
      // steal its properties for this item.
      if (!nested) visit(child);
    }
  };
  visit(scope);
  return item;
}

/** An itemscope that is also an itemprop belongs to the scope above it, and is
 * reported there rather than a second time at the top. */
const isNestedScope = (el: Element): boolean =>
  el.hasAttribute('itemprop') &&
  el.parentElement?.closest('[itemscope]') != null;

// ---------------------------------------------------------------------------
// RDFa
// ---------------------------------------------------------------------------

function rdfaResource(el: Element, base: string): string | undefined {
  for (const attribute of ['resource', 'href', 'src']) {
    const resolved = resolve(el.getAttribute(attribute), base);
    if (resolved) return resolved;
  }
  return undefined;
}

function rdfaValue(el: Element, base: string): string {
  const content = el.getAttribute('content');
  if (content !== null) return content.trim();
  return (
    rdfaResource(el, base) ?? el.getAttribute('datetime')?.trim() ?? text(el)
  );
}

function readRdfaItem(subject: Element, base: string): RdfaItem {
  const item: RdfaItem = {
    types: tokens(subject.getAttribute('typeof')),
    properties: {},
  };
  const vocab = subject.closest('[vocab]')?.getAttribute('vocab')?.trim();
  if (vocab) item.vocab = vocab;

  const visit = (el: Element): void => {
    for (const child of children(el)) {
      const names = tokens(child.getAttribute('property'));
      const nested = child.hasAttribute('typeof');
      if (names.length > 0) {
        // RdfaItem's properties are flat, so a nested subject is recorded here
        // only by the uri it identifies itself with — its own properties are
        // reported as the separate item it is, never flattened into this one.
        const value = nested
          ? rdfaResource(child, base)
          : rdfaValue(child, base);
        if (value !== undefined) {
          for (const name of names) (item.properties[name] ??= []).push(value);
        }
      }
      if (!nested) visit(child);
    }
  };
  visit(subject);
  return item;
}

// ---------------------------------------------------------------------------
// Social preview and SEO
// ---------------------------------------------------------------------------

function socialPreview(doc: Document, base: string): SocialPreview {
  // Keyed on property-or-name because pages publish og:* under name= and
  // twitter:* under property= often enough that honouring only the correct
  // spelling loses half the preview. First declaration wins, per OG.
  const metas = new Map<string, string>();
  for (const tag of Array.from(doc.querySelectorAll('meta'))) {
    const key = (tag.getAttribute('property') ?? tag.getAttribute('name'))
      ?.trim()
      .toLowerCase();
    const content = tag.getAttribute('content')?.trim();
    if (!key || !content || metas.has(key)) continue;
    metas.set(key, content);
  }

  const first = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = metas.get(key);
      if (value) return value;
    }
    return undefined;
  };

  const preview: SocialPreview = {};
  const title = first('og:title', 'twitter:title');
  if (title) preview.title = title;
  const description = first('og:description', 'twitter:description');
  if (description) preview.description = description;
  const image = first(
    'og:image',
    'og:image:url',
    'og:image:secure_url',
    'twitter:image',
    'twitter:image:src',
  );
  const imageUrl = image === undefined ? undefined : resolve(image, base);
  if (imageUrl) preview.image = imageUrl;
  const type = first('og:type', 'twitter:card');
  if (type) preview.type = type;
  const siteName = first('og:site_name', 'twitter:site');
  if (siteName) preview.siteName = siteName;
  return preview;
}

function seoReport(doc: Document, base: string): SeoReport {
  const report: SeoReport = { alternates: [], robots: [], feeds: [] };

  const canonical = resolve(
    doc.querySelector('link[rel~="canonical"]')?.getAttribute('href') ?? null,
    base,
  );
  if (canonical) report.canonical = canonical;

  // hreflang alternates and feeds share the rel, and a link may be one, the
  // other, or — on a translated feed — both.
  for (const link of Array.from(
    doc.querySelectorAll('link[rel~="alternate"]'),
  )) {
    const href = resolve(link.getAttribute('href'), base);
    if (!href) continue;
    const lang = link.getAttribute('hreflang')?.trim();
    if (lang) report.alternates.push({ lang, href });
    const type = link.getAttribute('type')?.trim().toLowerCase();
    if (type && /\b(rss|atom)\b/.test(type)) {
      const feed: FeedLink = { href, type };
      const title = link.getAttribute('title')?.trim();
      if (title) feed.title = title;
      report.feeds.push(feed);
    }
  }

  // Merged across tags rather than taking the first: a page that splits its
  // directives over two robots metas means all of them.
  const seen = new Set<string>();
  for (const tag of Array.from(doc.querySelectorAll('meta[name][content]'))) {
    if (tag.getAttribute('name')?.trim().toLowerCase() !== 'robots') continue;
    for (const token of (tag.getAttribute('content') ?? '').split(',')) {
      const directive = token.trim().toLowerCase();
      if (!directive || seen.has(directive)) continue;
      seen.add(directive);
      report.robots.push(directive);
    }
  }

  return report;
}

// ---------------------------------------------------------------------------

/**
 * Reads what the page already declares about itself. Parsing, not guessing:
 * every value here is something an author published deliberately, which is why
 * nothing in this domain carries a confidence tier.
 *
 * Malformed markup is the normal case on the real web, so no branch throws —
 * a block that will not parse becomes a warning and the rest of the page is
 * still reported.
 */
export const extractStructured: ExtractorMap['structured'] = (
  ctx,
): StructuredReport => {
  const { doc } = ctx;
  // Same precedence collect.ts uses: a <base href> beats the recorded page
  // url, and a page with neither still has the url the IR carries.
  const base =
    doc.querySelector('base')?.getAttribute('href')?.trim() ||
    ctx.ir.metadata.url;

  return {
    jsonLd: readJsonLd(ctx),
    microdata: Array.from(doc.querySelectorAll('[itemscope]'))
      .filter((el) => !isNestedScope(el))
      .map((el) => readMicrodataItem(el, base)),
    // Rooted at typeof only. Collecting bare `property` attributes as a
    // document-level subject would turn every page's og:* meta into a phantom
    // RDFa item duplicating the social preview below.
    //
    // Every typeof is reported, nested ones included: RdfaItem's properties
    // are flat, so a nested subject listed only under its parent's property
    // would lose its own properties entirely.
    rdfa: Array.from(doc.querySelectorAll('[typeof]')).map((el) =>
      readRdfaItem(el, base),
    ),
    social: socialPreview(doc, base),
    seo: seoReport(doc, base),
  };
};
