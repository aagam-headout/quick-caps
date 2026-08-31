import { parseHTML } from 'linkedom';
import type { PageIR, StyleSource, Warning } from '../../../src/ir.js';
import { emptyTally } from '../../../src/collect.js';
import type { ExtractorContext } from '../../../src/extract/types.js';

/**
 * Design fixtures are built by hand rather than run through
 * `collectFromDocument`: the design extractor reads only `doc` and
 * `ir.styles`, and a hand-built IR keeps these cases free of the fake layout
 * boxes region building needs.
 */
export function designContext(input: {
  html: string;
  styles?: StyleSource[];
}): { ctx: ExtractorContext; warnings: Omit<Warning, 'phase'>[] } {
  const { document } = parseHTML(input.html);
  const doc = document as unknown as Document;
  const ir: PageIR = {
    metadata: {
      url: 'https://example.com/page',
      title: doc.title,
      capturedAt: '2026-08-31T10:00:00.000Z',
      viewport: { width: 1280, height: 800 },
      documentSize: { width: 1280, height: 2400 },
      devicePixelRatio: 2,
      userAgent: 'test-agent',
      charset: 'utf-8',
      meta: {},
    },
    html: input.html,
    regions: [],
    styles: input.styles ?? [],
    assets: [],
    styleTally: emptyTally(),
    warnings: [],
  };
  const warnings: Omit<Warning, 'phase'>[] = [];
  return {
    ctx: { doc, ir, warn: (warning) => warnings.push(warning) },
    warnings,
  };
}

export const inline = (text: string, index = 0): StyleSource => ({
  kind: 'inline',
  text,
  index,
});

export const sameOrigin = (text: string, href: string): StyleSource => ({
  kind: 'same-origin',
  text,
  href,
});

export const crossOrigin = (href: string): StyleSource => ({
  kind: 'cross-origin',
  href,
});

/** Four near-identical primary buttons, two secondary ones, and three cards
 * whose only difference is their text — the shape a component inventory has to
 * collapse instead of reporting nine one-off elements. */
export const REPEATED_COMPONENTS_HTML = `<!doctype html>
<html><body>
  <main class="content">
    <div class="row">
      <button class="btn btn-primary" type="button"><span>Buy</span></button>
      <button class="btn btn-primary" type="button"><span>Buy now</span></button>
      <button class="btn btn-primary" type="button"><span>Add</span></button>
      <button class="btn btn-primary" type="button"><span>Save</span></button>
      <button class="btn btn-secondary" type="button"><span>Cancel</span></button>
      <button class="btn btn-secondary" type="button"><span>Back</span></button>
    </div>
    <ul class="grid">
      <li class="card card-3xk1f9"><h3>One</h3><p>First</p></li>
      <li class="card card-a91bd2"><h3>Two</h3><p>Second</p></li>
      <li class="card card-77c0e4"><h3>Three</h3><p>Third</p></li>
    </ul>
    <div role="button" tabindex="0" class="fake-btn">Pretend</div>
    <p>An unclassed paragraph that is nobody's component.</p>
  </main>
</body></html>`;

/** Nested @media, an @font-face with two sources, a font-family stack, grid
 * declarations, and a container max-width — one sheet exercising every reader. */
export const DESIGN_SYSTEM_CSS = `
@font-face {
  font-family: "Inter";
  src: url("/fonts/inter.woff2") format("woff2"),
       url("/fonts/inter.woff") format("woff");
  font-weight: 400;
  font-style: normal;
}
@font-face {
  font-family: 'Inter';
  src: url("/fonts/inter-bold.woff2") format("woff2");
  font-weight: 700;
  font-style: normal;
}
body { font-family: "Inter", Helvetica, sans-serif; }
code { font-family: var(--mono); }
.container { max-width: 1200px; margin: 0 auto; }
.narrow { max-width: 40rem; }
.icon { max-width: 24px; }
.grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
@media (min-width: 48rem) {
  .grid { grid-template-columns: repeat(2, 1fr); gap: 24px; }
  .row { display: flex; }
  @media (orientation: landscape) {
    .grid { gap: 32px; }
  }
}
@media screen and (min-width: 1024px) {
  .grid { grid-template-columns: repeat(3, 1fr); }
}
@media print {
  .row { display: none; }
}
`;

/** One primary and one secondary button, neither repeated. This is the case a
 * per-signature threshold cannot report at all: variants are deliberately
 * distinct signatures, so each counts 1 and "2 button variants" vanishes. */
export const TWO_BUTTON_VARIANTS_HTML = `<!doctype html>
<html><body>
  <button class="btn btn-primary">Buy</button>
  <button class="btn btn-secondary">Save</button>
</body></html>`;

/** Two classed divs sharing nothing but their tag. A kind-level threshold must
 * not read them as two variants of one 'div' component. */
export const UNRELATED_DIVS_HTML = `<!doctype html>
<html><body>
  <div class="sidebar"><span>a</span></div>
  <div class="promo-banner"><em>b</em></div>
</body></html>`;
