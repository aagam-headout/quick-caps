import type { ActionRef, Region } from './ir.js';

export type RegionOptions = {
  /** Hard recursion cap. Deeply nested pages are common; unbounded is not. */
  maxDepth: number;
};

const SKIP_TAGS = new Set([
  'script',
  'style',
  'link',
  'meta',
  'head',
  'title',
  'noscript',
  'template',
]);

const ROLE_BY_TAG: Record<string, string> = {
  header: 'banner',
  footer: 'contentinfo',
  nav: 'navigation',
  main: 'main',
  aside: 'complementary',
  form: 'form',
  section: 'region',
  article: 'article',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  table: 'table',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
};

function ownTextLength(el: Element): number {
  let total = 0;
  for (const node of el.childNodes) {
    if (node.nodeType === 3) total += (node.textContent ?? '').trim().length;
  }
  return total;
}

function boxOf(el: Element): Region['box'] {
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
  };
}

function labelFor(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/**
 * Structural tree of the page. One collapsing rule keeps it shallow: a generic
 * element with exactly one element child and no own text is a wrapper, and its
 * child takes its place. An element carrying a role — explicit or inferred from
 * its tag — is never a wrapper, however thin it looks: collapsing <header> would
 * lose the landmark that makes the tree navigable.
 */
export function buildRegions(doc: Document, options: RegionOptions): Region[] {
  let nextRegionId = 1;
  let nextActionId = 1;

  const roleOf = (el: Element, tag: string): string | undefined =>
    el.getAttribute('role') ?? ROLE_BY_TAG[tag];

  const actionsIn = (el: Element): ActionRef[] => {
    const actions: ActionRef[] = [];
    for (const node of el.children) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'a' && node.hasAttribute('href')) {
        actions.push({
          id: nextActionId++,
          type: 'link',
          label: labelFor(node),
          href: node.getAttribute('href') ?? '',
        });
      } else if (tag === 'button') {
        actions.push({
          id: nextActionId++,
          type: 'button',
          label: labelFor(node),
        });
      } else if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        actions.push({
          id: nextActionId++,
          type: 'input',
          label: node.getAttribute('name') ?? labelFor(node),
        });
      }
    }
    return actions;
  };

  const isWrapper = (el: Element, tag: string): boolean =>
    el.children.length === 1 &&
    ownTextLength(el) === 0 &&
    roleOf(el, tag) === undefined;

  const build = (el: Element, depth: number): Region[] => {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return [];
    if (depth > options.maxDepth) return [];

    if (isWrapper(el, tag)) {
      const only = el.children[0];
      return only ? build(only, depth) : [];
    }

    // Ids are claimed before recursing, so a flattened walk reads in document
    // order. Region 1 is the first thing on the page, which is what makes a
    // numbered handle meaningful to anyone reading the tree.
    const id = nextRegionId++;
    const children: Region[] = [];
    for (const child of el.children) children.push(...build(child, depth + 1));

    const box = boxOf(el);
    const area = box.w * box.h;
    const textLength = (el.textContent ?? '').trim().length;

    return [
      {
        id,
        role: roleOf(el, tag) ?? 'generic',
        tag,
        box,
        textLength,
        textDensity:
          area > 0 ? Number(((textLength * 1000) / area).toFixed(3)) : 0,
        actions: actionsIn(el),
        children,
      },
    ];
  };

  const roots: Region[] = [];
  for (const child of doc.body?.children ?? []) roots.push(...build(child, 1));
  return roots;
}
