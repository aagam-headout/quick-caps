import type {
  ContentReport,
  DataReport,
  DesignReport,
  EntityReport,
  Extracted,
  ExtractDomain,
  JsonLdNode,
  LinkReport,
  MicrodataItem,
  PaginationTarget,
  Price,
  Provenance,
  RdfaItem,
  StructuredReport,
  Confidence,
} from 'quick-caps-core/extract';
import { EXTRACT_DOMAINS } from 'quick-caps-core/extract';

/** Fits every label the sections below emit, so the value column lines up
 * down the whole report; a longer label only pushes its own row right. */
const LABEL_WIDTH = 10;
const SOURCE_WIDTH = 16;
const VALUE_CAP = 52;
const MATCHED_CAP = 44;
/** Rows per category. Past this a reader is skimming rather than reading —
 * and the elision line below says so, so nothing disappears in silence. */
const MAX_ROWS = 6;

type Row = {
  label: string;
  value: string;
  /** Present together: an entity value without its provenance and tier is
   * exactly the thing this rendering exists to stop hiding. */
  source?: Provenance;
  confidence?: Confidence;
  /** Only carried for a low-confidence value — see attachRow. */
  matched?: string;
  /** A whole-block statement rather than a labelled field, so it sits at the
   * block's own indent instead of in an empty label column. */
  bare?: boolean;
};

type Cell = Omit<Row, 'label'>;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function truncate(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

/**
 * Emits one category: the label on the first row, blank on continuations, so
 * repeated prices or breakpoints read as one group. Rows past MAX_ROWS become
 * a pointer at `--json` rather than vanishing.
 */
function pushRows(rows: Row[], label: string, cells: Cell[]): void {
  const shown = cells.slice(0, MAX_ROWS);
  shown.forEach((cell, index) => {
    rows.push({ label: index === 0 ? label : '', ...cell });
  });
  const hidden = cells.length - shown.length;
  if (hidden > 0) {
    rows.push({
      label: shown.length === 0 ? label : '',
      value: `… ${hidden} more (--json)`,
    });
  }
}

/** Carries `matched` only for a low-confidence value: that is the tier where
 * a reader has to judge the guess, and the tiers above would just be noise. */
function attachRow<T>(item: Extracted<T>, format: (value: T) => string): Cell {
  return {
    value: format(item.value),
    source: item.source,
    confidence: item.confidence,
    ...(item.confidence === 'low' &&
      item.matched !== undefined && { matched: item.matched }),
  };
}

function renderRows(rows: Row[]): string[] {
  const width = Math.min(
    VALUE_CAP,
    Math.max(0, ...rows.map((row) => truncate(row.value, VALUE_CAP).length)),
  );
  return rows.map((row) => {
    const value = truncate(row.value, VALUE_CAP);
    if (row.bare === true) return `  ${value}`;
    const head = `  ${row.label.padEnd(LABEL_WIDTH)} ${
      row.source === undefined ? value : value.padEnd(width)
    }`;
    if (row.source === undefined) return head.trimEnd();
    const provenance = `  ${row.source.padEnd(SOURCE_WIDTH)}${row.confidence ?? ''}`;
    const matched =
      row.matched === undefined
        ? ''
        : `  "${truncate(row.matched, MATCHED_CAP)}"`;
    return `${head}${provenance}${matched}`.trimEnd();
  });
}

// ---------------------------------------------------------------------------
// structured
// ---------------------------------------------------------------------------

/** Last path segment of a schema.org URL — `Product`, not the whole vocab. */
function shortType(raw: string): string {
  return raw.split(/[/#]/).filter(Boolean).pop() ?? raw;
}

function typeLabel(raw: unknown): string {
  const types = Array.isArray(raw) ? raw : [raw];
  const names = types
    .filter((type): type is string => typeof type === 'string')
    .map(shortType);
  return names.length > 0 ? names.join('/') : '(untyped)';
}

function nodeName(node: JsonLdNode): string | undefined {
  for (const key of ['name', 'headline', 'title']) {
    const value = node[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function itemLabel(item: MicrodataItem | RdfaItem): string {
  const count = Object.keys(item.properties).length;
  return `${typeLabel(item.types)} (${count} props)`;
}

function structuredRows(report: StructuredReport): Row[] {
  const rows: Row[] = [];
  pushRows(
    rows,
    'json-ld',
    report.jsonLd.map((node) => {
      const name = nodeName(node);
      return {
        value: `${typeLabel(node['@type'])}${name === undefined ? '' : ` "${name}"`}`,
      };
    }),
  );
  pushRows(
    rows,
    'microdata',
    report.microdata.map((item) => ({ value: itemLabel(item) })),
  );
  pushRows(
    rows,
    'rdfa',
    report.rdfa.map((item) => ({ value: itemLabel(item) })),
  );

  const { title, image, siteName } = report.social;
  const preview = [
    title === undefined ? undefined : `"${title}"`,
    image,
    siteName,
  ].filter((part): part is string => part !== undefined);
  if (preview.length > 0)
    rows.push({ label: 'preview', value: preview.join(' — ') });

  const { seo } = report;
  if (seo.canonical !== undefined) {
    rows.push({ label: 'canonical', value: seo.canonical });
  }
  pushRows(
    rows,
    'alternate',
    seo.alternates.map((alt) => ({ value: `${alt.lang} → ${alt.href}` })),
  );
  if (seo.robots.length > 0) {
    rows.push({ label: 'robots', value: seo.robots.join(', ') });
  }
  pushRows(
    rows,
    'feed',
    seo.feeds.map((feed) => ({ value: `${feed.href} (${feed.type})` })),
  );
  return rows;
}

// ---------------------------------------------------------------------------
// entities
// ---------------------------------------------------------------------------

function priceText(price: Price): string {
  const amount = `${price.amount}${price.currency === undefined ? '' : ` ${price.currency}`}`;
  return price.kind === undefined ? amount : `${amount} (${price.kind})`;
}

const PAGINATION_LABEL: Record<PaginationTarget['kind'], string> = {
  next: 'next page',
  prev: 'prev page',
  numbered: 'page',
  'load-more': 'load more',
};

function paginationText(target: PaginationTarget): string {
  return (
    target.href ??
    target.label ??
    (target.domPath === undefined
      ? '(no target)'
      : `dom ${target.domPath.join('.')}`)
  );
}

function entityRows(report: EntityReport): Row[] {
  const rows: Row[] = [];
  pushRows(
    rows,
    'price',
    report.prices.map((price) => attachRow(price, priceText)),
  );
  if (report.availability !== undefined) {
    pushRows(rows, 'stock', [attachRow(report.availability, (value) => value)]);
  }

  const dates: [string, Extracted<string> | undefined][] = [
    ['published', report.dates.published],
    ['modified', report.dates.modified],
    ['starts', report.dates.eventStart],
    ['ends', report.dates.eventEnd],
  ];
  for (const [label, date] of dates) {
    if (date !== undefined) {
      pushRows(rows, label, [attachRow(date, (value) => value)]);
    }
  }

  pushRows(
    rows,
    'author',
    report.authors.map((author) => attachRow(author, (value) => value.name)),
  );
  pushRows(
    rows,
    'rating',
    report.ratings.map((rating) =>
      attachRow(rating, (value) => {
        const scale = value.best === undefined ? '' : `/${value.best}`;
        const reviews =
          value.reviewCount === undefined
            ? ''
            : ` (${value.reviewCount} reviews)`;
        return `${value.value}${scale}${reviews}`;
      }),
    ),
  );

  const { contacts } = report;
  pushRows(
    rows,
    'email',
    contacts.emails.map((email) => attachRow(email, (value) => value)),
  );
  pushRows(
    rows,
    'phone',
    contacts.phones.map((phone) => attachRow(phone, (value) => value)),
  );
  pushRows(
    rows,
    'address',
    contacts.addresses.map((address) =>
      attachRow(
        address,
        (value) =>
          value.raw ??
          [
            value.street,
            value.locality,
            value.region,
            value.postalCode,
            value.country,
          ]
            .filter((part) => part !== undefined)
            .join(', '),
      ),
    ),
  );
  pushRows(
    rows,
    'social',
    contacts.socials.map((social) =>
      attachRow(social, (value) => `${value.platform} ${value.handle}`),
    ),
  );

  for (const kind of ['next', 'prev', 'numbered', 'load-more'] as const) {
    const targets = report.pagination.filter(
      (item) => item.value.kind === kind,
    );
    pushRows(
      rows,
      PAGINATION_LABEL[kind],
      targets.map((target) => attachRow(target, paginationText)),
    );
  }
  return rows;
}

// ---------------------------------------------------------------------------
// content
// ---------------------------------------------------------------------------

function contentRows(report: ContentReport): Row[] {
  const rows: Row[] = [];
  const language = report.language === undefined ? '' : `, ${report.language}`;
  rows.push({
    label: '',
    bare: true,
    value: `${report.wordCount} words, ~${report.readingTimeMinutes} min${language}`,
  });

  if (report.outline.length > 0) {
    const path = report.outline
      .slice(0, MAX_ROWS)
      .map((heading) => `h${heading.level}`)
      .join(' > ');
    const rest =
      report.outline.length - Math.min(MAX_ROWS, report.outline.length);
    const violations = report.outlineViolations;
    const detail =
      violations.length === 0
        ? ''
        : ` — ${violations.length} violation${violations.length === 1 ? '' : 's'}: ${[
            ...new Set(violations.map((violation) => violation.kind)),
          ].join(', ')}`;
    rows.push({
      label: 'outline',
      value: `${path}${rest > 0 ? ` +${rest}` : ''}${detail}`,
    });
  }

  const { items } = report.media;
  if (items.length > 0) {
    const noAlt = items.filter(
      (item) => item.alt === undefined || item.alt.trim().length === 0,
    ).length;
    rows.push({
      label: 'media',
      value: `${items.length} items, ${noAlt} without alt`,
    });
  }

  const { split } = report;
  if (split.mainRegionIds.length > 0 || split.boilerplateRegionIds.length > 0) {
    rows.push({
      label: 'split',
      value: `main ${split.mainWordCount} words in ${plural(split.mainRegionIds.length, 'region')}, boilerplate ${split.boilerplateRegionIds.length} (${split.confidence})`,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// design
// ---------------------------------------------------------------------------

function designRows(report: DesignReport): Row[] {
  const rows: Row[] = [];
  for (const pattern of report.components.slice(0, MAX_ROWS)) {
    const variants = pattern.variants
      .slice(0, MAX_ROWS)
      .map((variant) => variant.signature)
      .join(', ');
    rows.push({
      label: pattern.kind,
      value: `${pattern.count}  (${variants})`,
    });
  }
  const hiddenComponents =
    report.components.length - Math.min(MAX_ROWS, report.components.length);
  if (hiddenComponents > 0) {
    rows.push({ label: '', value: `… ${hiddenComponents} more (--json)` });
  }

  pushRows(
    rows,
    'font',
    report.fonts.map((font) => {
      const sources =
        font.sources.length === 0 ? '' : ` (${font.sources.length} src)`;
      const weights =
        font.weights.length === 0 ? '' : ` ${font.weights.join('/')}`;
      return { value: `${font.family}${sources}${weights}` };
    }),
  );
  pushRows(
    rows,
    'breakpoint',
    report.breakpoints.map((breakpoint) => ({
      value: `${breakpoint.query} (${breakpoint.ruleCount} rules)`,
    })),
  );

  const { grid } = report;
  const columns = Object.keys(grid.templateColumns)[0];
  const gap = Object.keys(grid.gaps)[0];
  const parts = [
    columns === undefined ? undefined : columns,
    gap === undefined ? undefined : `gap ${gap}`,
    grid.containerWidths.length === 0
      ? undefined
      : `container ${grid.containerWidths.join('/')}px`,
  ].filter((part): part is string => part !== undefined);
  if (parts.length > 0) rows.push({ label: 'grid', value: parts.join('; ') });
  return rows;
}

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------

function linkRows(report: LinkReport): Row[] {
  if (report.links.length === 0) return [];
  const zones = new Map<string, number>();
  for (const link of report.links) {
    zones.set(link.zone, (zones.get(link.zone) ?? 0) + 1);
  }
  const byZone = [...zones]
    .map(([zone, count]) => `${zone} ${count}`)
    .join(', ');
  const rows: Row[] = [
    { label: 'total', value: `${report.links.length} — ${byZone}` },
  ];
  const hosts = Object.entries(report.byHost)
    .sort(([, a], [, b]) => b - a)
    .slice(0, MAX_ROWS)
    .map(([host, count]) => `${host} ${count}`)
    .join(', ');
  rows.push({
    label: 'external',
    value: `${report.externalCount}${hosts.length === 0 ? '' : ` — ${hosts}`}`,
  });
  return rows;
}

// ---------------------------------------------------------------------------

/** Spelled out rather than a keyed table, for the reason registry.ts gives
 * for the same shape: a lookup keyed by domain needs a cast to line each
 * report type up with its renderer, and the cast is the worse trade. */
function domainRows(report: Partial<DataReport>, domain: ExtractDomain): Row[] {
  switch (domain) {
    case 'structured':
      return report.structured === undefined
        ? []
        : structuredRows(report.structured);
    case 'entities':
      return report.entities === undefined ? [] : entityRows(report.entities);
    case 'content':
      return report.content === undefined ? [] : contentRows(report.content);
    case 'design':
      return report.design === undefined ? [] : designRows(report.design);
    case 'links':
      return report.links === undefined ? [] : linkRows(report.links);
  }
}

/**
 * The default rendering: one block per requested domain, in canonical domain
 * order, in the same terse register `open` and `layout` print. Machine
 * consumers take `--json` instead — the point of the split is that neither
 * form has to compromise for the other.
 */
export function renderDataReport(
  report: Partial<DataReport>,
  domains: ExtractDomain[],
): string {
  const requested = new Set(domains);
  const blocks: string[] = [];
  for (const domain of EXTRACT_DOMAINS) {
    if (!requested.has(domain)) continue;
    if (report[domain] === undefined) {
      // Absent means the extractor failed outright; the warnings say why.
      blocks.push(`${domain}\n  (unavailable)`);
      continue;
    }
    const rows = domainRows(report, domain);
    // An empty domain must read as empty rather than as absent: "nothing
    // here" and "we could not look" are different answers.
    const body = rows.length === 0 ? ['  (empty)'] : renderRows(rows);
    blocks.push([domain, ...body].join('\n'));
  }
  const warnings = (report.warnings ?? []).map(
    (warning) => `warning: ${warning.reason}`,
  );
  if (warnings.length > 0) blocks.push(warnings.join('\n'));
  return blocks.join('\n\n');
}
