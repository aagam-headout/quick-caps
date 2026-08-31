import { describe, expect, it } from 'vitest';
import { extractDesign } from '../../src/extract/design.js';
import {
  DESIGN_SYSTEM_CSS,
  REPEATED_COMPONENTS_HTML,
  crossOrigin,
  designContext,
  inline,
  sameOrigin,
} from './fixtures/design.js';

const BLANK_HTML =
  '<!doctype html><html><body><p>Nothing here.</p></body></html>';

function patternFor(
  report: ReturnType<typeof extractDesign>,
  match: string,
): (typeof report.components)[number] | undefined {
  return report.components.find((pattern) => pattern.signature.includes(match));
}

describe('extractDesign — component inventory', () => {
  it('collapses near-identical instances into one pattern per variant', () => {
    const { ctx } = designContext({ html: REPEATED_COMPONENTS_HTML });
    const report = extractDesign(ctx);

    const primary = patternFor(report, 'btn-primary');
    const secondary = patternFor(report, 'btn-secondary');
    expect(primary?.count).toBe(4);
    expect(primary?.kind).toBe('button');
    expect(secondary?.count).toBe(2);
    expect(secondary?.kind).toBe('button');
  });

  it('groups instances whose class differs only by a build hash', () => {
    const { ctx } = designContext({ html: REPEATED_COMPONENTS_HTML });
    const card = patternFor(extractDesign(ctx), 'card');

    expect(card?.count).toBe(3);
    expect(card?.kind).toBe('card');
  });

  it('reports patterns most frequent first, with example dom paths', () => {
    const { ctx } = designContext({ html: REPEATED_COMPONENTS_HTML });
    const report = extractDesign(ctx);

    const counts = report.components.map((pattern) => pattern.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(patternFor(report, 'btn-primary')?.examples[0]).toEqual([0, 0, 0]);
  });

  it('drops one-off elements and unclassed prose', () => {
    const { ctx } = designContext({ html: REPEATED_COMPONENTS_HTML });
    const report = extractDesign(ctx);

    expect(report.components.every((pattern) => pattern.count >= 2)).toBe(true);
    expect(patternFor(report, 'fake-btn')).toBeUndefined();
  });

  it('recognizes a role that contradicts its tag', () => {
    const { ctx } = designContext({
      html: `<!doctype html><html><body><div role="button" class="x">a</div>
        <div role="button" class="x">b</div></body></html>`,
    });
    const report = extractDesign(ctx);

    expect(report.components[0]?.kind).toBe('button');
    expect(report.components[0]?.signature).toContain('[button]');
  });

  it('returns an empty inventory for a page with no repeated shapes', () => {
    const { ctx, warnings } = designContext({ html: BLANK_HTML });

    expect(extractDesign(ctx).components).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('extractDesign — declared fonts', () => {
  it('merges @font-face rules for one family and keeps every source', () => {
    const { ctx } = designContext({
      html: BLANK_HTML,
      styles: [inline(DESIGN_SYSTEM_CSS)],
    });
    const inter = extractDesign(ctx).fonts.find(
      (font) => font.family === 'Inter',
    );

    expect(inter?.sources).toEqual([
      '/fonts/inter.woff2',
      '/fonts/inter.woff',
      '/fonts/inter-bold.woff2',
    ]);
    expect(inter?.weights).toEqual(['400', '700']);
    expect(inter?.styles).toEqual(['normal']);
  });

  it('records stack families without sources and skips generics and vars', () => {
    const { ctx } = designContext({
      html: BLANK_HTML,
      styles: [inline(DESIGN_SYSTEM_CSS)],
    });
    const families = extractDesign(ctx).fonts.map((font) => font.family);

    expect(families).toContain('Helvetica');
    expect(families).not.toContain('sans-serif');
    expect(families.some((family) => family.includes('var('))).toBe(false);
    const helvetica = extractDesign(ctx).fonts.find(
      (font) => font.family === 'Helvetica',
    );
    expect(helvetica?.sources).toEqual([]);
  });
});

describe('extractDesign — breakpoints', () => {
  it('reads nested media queries as their own breakpoints', () => {
    const { ctx } = designContext({
      html: BLANK_HTML,
      styles: [inline(DESIGN_SYSTEM_CSS)],
    });
    const queries = extractDesign(ctx).breakpoints.map((bp) => bp.query);

    expect(queries).toContain('(min-width: 48rem)');
    expect(queries).toContain('(orientation: landscape)');
    expect(queries).toContain('screen and (min-width: 1024px)');
    expect(queries).toContain('print');
  });

  it('parses simple width bounds and converts rem to px', () => {
    const { ctx } = designContext({
      html: BLANK_HTML,
      styles: [inline(DESIGN_SYSTEM_CSS)],
    });
    const byQuery = new Map(
      extractDesign(ctx).breakpoints.map((bp) => [bp.query, bp]),
    );

    expect(byQuery.get('(min-width: 48rem)')?.minWidth).toBe(768);
    expect(byQuery.get('screen and (min-width: 1024px)')?.minWidth).toBe(1024);
    expect(byQuery.get('print')?.minWidth).toBeUndefined();
  });

  it('counts only the rules directly under a query, not its nested ones', () => {
    const { ctx } = designContext({
      html: BLANK_HTML,
      styles: [inline(DESIGN_SYSTEM_CSS)],
    });
    const byQuery = new Map(
      extractDesign(ctx).breakpoints.map((bp) => [bp.query, bp]),
    );

    expect(byQuery.get('(min-width: 48rem)')?.ruleCount).toBe(2);
    expect(byQuery.get('(orientation: landscape)')?.ruleCount).toBe(1);
  });

  it('deduplicates one query across stylesheets and sums its rules', () => {
    const { ctx } = designContext({
      html: BLANK_HTML,
      styles: [
        inline('@media (min-width: 600px) { .a { color: red; } }'),
        sameOrigin(
          '@media (min-width:600px) { .b { color: blue; } .c { color: green; } }',
          'https://example.com/app.css',
        ),
      ],
    });
    const { breakpoints } = extractDesign(ctx);

    expect(breakpoints).toHaveLength(1);
    expect(breakpoints[0]?.ruleCount).toBe(3);
    expect(breakpoints[0]?.minWidth).toBe(600);
  });

  it('orders breakpoints by ascending width', () => {
    const { ctx } = designContext({
      html: BLANK_HTML,
      styles: [
        inline(
          '@media (min-width: 1024px) { .a { color: red; } }' +
            '@media (min-width: 640px) { .b { color: red; } }',
        ),
      ],
    });

    expect(extractDesign(ctx).breakpoints.map((bp) => bp.minWidth)).toEqual([
      640, 1024,
    ]);
  });
});

describe('extractDesign — grid inference', () => {
  it('tallies template columns, gaps, and container widths', () => {
    const { ctx } = designContext({
      html: BLANK_HTML,
      styles: [inline(DESIGN_SYSTEM_CSS)],
    });
    const { grid } = extractDesign(ctx);

    expect(grid.templateColumns).toEqual({
      '1fr': 1,
      'repeat(2, 1fr)': 1,
      'repeat(3, 1fr)': 1,
    });
    expect(grid.gaps).toEqual({ '16px': 1, '24px': 1, '32px': 1 });
    expect(grid.containerWidths).toEqual([640, 1200]);
  });

  it('does not mistake a media query bound for a container width', () => {
    const { ctx } = designContext({
      html: BLANK_HTML,
      styles: [inline('@media (max-width: 900px) { .a { color: red; } }')],
    });

    expect(extractDesign(ctx).grid.containerWidths).toEqual([]);
  });
});

describe('extractDesign — unreadable and missing stylesheets', () => {
  it('warns naming the cross-origin sheets it could not read', () => {
    const { ctx, warnings } = designContext({
      html: BLANK_HTML,
      styles: [
        crossOrigin('https://cdn.example.com/a.css'),
        crossOrigin('https://fonts.example.com/b.css'),
        inline('@media (min-width: 600px) { .a { color: red; } }'),
      ],
    });
    const report = extractDesign(ctx);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.detail).toContain('https://cdn.example.com/a.css');
    expect(warnings[0]?.detail).toContain('https://fonts.example.com/b.css');
    // The readable sheet still contributes: a warning is a degradation, not a
    // bail-out.
    expect(report.breakpoints).toHaveLength(1);
  });

  it('returns a well-formed empty report for a page with no stylesheets', () => {
    const { ctx, warnings } = designContext({ html: BLANK_HTML, styles: [] });

    expect(extractDesign(ctx)).toEqual({
      components: [],
      fonts: [],
      breakpoints: [],
      grid: { templateColumns: {}, gaps: {}, containerWidths: [] },
    });
    expect(warnings).toEqual([]);
  });

  it('does not throw on a document with no body', () => {
    const { ctx } = designContext({ html: '<html><head></head></html>' });

    expect(() => extractDesign(ctx)).not.toThrow();
  });
});
