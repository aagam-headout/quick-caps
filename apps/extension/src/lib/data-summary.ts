import type { DataReport, JsonLdNode, Price } from 'quick-caps-core/extract';

/**
 * The post-capture line the popup shows.
 *
 * Not `formatAvailability`, which is the other summariser in this codebase:
 * that one answers an agent's "which domains are worth paying for" with
 * `structured(3) entities(11) links(47)`, naming domains and counting
 * findings. The popup's reader has already paid, and wants to know what is
 * *in* the file — "1 product, price $49.99, 2 authors" — which is entity
 * text, not a domain menu.
 */

/** How many declared-type groups are worth naming before the line stops
 * being a summary. */
const MAX_TYPES = 2;

const plural = (count: number, noun: string): string =>
  `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;

/** `@type` can be a string, an array, or absent; anything else is ignored
 * rather than stringified into the summary. */
function typeNamesOf(node: JsonLdNode): string[] {
  const raw = node['@type'];
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.split(/[/#]/).pop() ?? value)
    .map((value) => value.toLowerCase())
    .filter((value) => value.length > 0);
}

function declaredTypes(nodes: JsonLdNode[]): string[] {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    // Only the first type of a multi-typed node: a node declaring both
    // Product and Thing is one product, not two things.
    const [name] = typeNamesOf(node);
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TYPES)
    .map(([name, count]) => plural(count, name));
}

function formatPrice(price: Price): string {
  const amount = price.amount.toFixed(2).replace(/\.00$/, '');
  if (price.currency === undefined) return `price ${amount}`;
  try {
    const formatted = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: price.currency,
    }).format(price.amount);
    // A whole price reads as machine output with its trailing zeros on.
    return `price ${formatted.replace(/[.,]00$/, '')}`;
  } catch {
    // An unrecognized ISO code throws rather than falling back.
    return `price ${amount} ${price.currency}`;
  }
}

export function summarizeData(report: Partial<DataReport>): string {
  const parts: string[] = [];

  if (report.structured) parts.push(...declaredTypes(report.structured.jsonLd));

  const entities = report.entities;
  if (entities) {
    const [price] = entities.prices;
    if (price) parts.push(formatPrice(price.value));
    if (entities.authors.length > 0) {
      parts.push(plural(entities.authors.length, 'author'));
    }
    const [rating] = entities.ratings;
    if (rating) {
      parts.push(
        `rated ${rating.value.value}${rating.value.best === undefined ? '' : `/${rating.value.best}`}`,
      );
    }
  }

  if (report.content && report.content.wordCount > 0) {
    parts.push(plural(report.content.wordCount, 'word'));
  }

  const links = report.links;
  if (links) {
    const total = links.internalCount + links.externalCount;
    if (total > 0) parts.push(plural(total, 'link'));
  }

  const warnings = report.warnings ?? [];
  const lines =
    parts.length > 0
      ? [`Found: ${parts.join(', ')}.`]
      : ['No extractable data found.'];
  if (warnings.length > 0) {
    lines.push(`${plural(warnings.length, 'extraction warning')} — see below.`);
  }
  return lines.join('\n');
}
