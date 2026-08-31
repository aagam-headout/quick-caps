import { parseHTML } from 'linkedom';
import { collectFromDocument } from '../../../src/collect.js';
import { defaultSettings } from '../../../src/settings.js';
import type { Warning } from '../../../src/ir.js';
import type { ExtractorContext } from '../../../src/extract/types.js';

/**
 * Parses a fixture and gives every element a layout box, because linkedom has
 * no layout engine and `textDensity` — which the main-versus-boilerplate split
 * reads — is meaningless without one. `data-box="x,y,w,h"` pins a specific
 * geometry where a test cares about it; everything else falls back to a
 * document-order band, the same trick tests/fake-driver.ts uses.
 */
function parseFixture(html: string, geometry: Geometry) {
  const parsed = parseHTML(html);
  let index = 0;
  for (const el of parsed.document.querySelectorAll('*')) {
    const position = index++;
    const declared = el.getAttribute('data-box');
    const [x, y, w, h] =
      geometry === 'none'
        ? [0, 0, 0, 0]
        : declared
          ? declared.split(',').map((part) => Number(part.trim()))
          : [0, position * 40, 800, 40];
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x,
        y,
        width: w,
        height: h,
        top: y,
        left: x,
        right: (x ?? 0) + (w ?? 0),
        bottom: (y ?? 0) + (h ?? 0),
      }),
    });
  }
  return parsed;
}

export type ContentHarness = {
  ctx: ExtractorContext;
  /** Everything the extractor degraded on, in the order it said so. */
  warnings: Omit<Warning, 'phase'>[];
};

/**
 * `none` is what a static session actually is: linkedom has no layout engine,
 * so every getBoundingClientRect is zeros and every Region.box and
 * textDensity collapses to 0. That is `pc data`'s default path, not an edge
 * case, so the split has to be exercised against it.
 */
export type Geometry = 'measured' | 'none';

export type HarnessOptions = {
  pageUrl?: string;
  geometry?: Geometry;
  /** Lowered by the media test to push an image below the region tree, which
   * is the only way a real page loses its displayed box. */
  maxRegionDepth?: number;
};

/** A context over `html`, built through the real collector so the Region tree
 * the extractor reads is the one a real capture would hand it. */
export function harness(
  html: string,
  options: HarnessOptions = {},
): ContentHarness {
  const doc = parseFixture(html, options.geometry ?? 'measured')
    .document as unknown as Document;
  const ir = collectFromDocument(doc, {
    settings: defaultSettings,
    pageUrl: options.pageUrl ?? 'https://example.com/page',
    ...(options.maxRegionDepth === undefined
      ? {}
      : { maxRegionDepth: options.maxRegionDepth }),
    userAgent: 'test-agent',
    viewport: { width: 1280, height: 800 },
    documentSize: { width: 1280, height: 2400 },
    devicePixelRatio: 2,
    now: () => new Date('2026-08-31T10:00:00.000Z'),
  });
  const warnings: Omit<Warning, 'phase'>[] = [];
  return {
    ctx: { doc, ir, warn: (warning) => warnings.push(warning) },
    warnings,
  };
}

/** A landmarked article page: the case everything else is a deviation from. */
export const ARTICLE = `<!doctype html>
<html lang="en-GB">
  <head><title>Kettle review</title></head>
  <body>
    <header data-box="0,0,1280,80">
      <nav><a href="/">Home</a> <a href="/reviews">Reviews</a></nav>
    </header>
    <main data-box="0,80,800,1200">
      <article>
        <h1>The kettle review</h1>
        <p>
          A kettle boils water and then it stops boiling water, which is the
          whole of the product and the whole of this paragraph about it.
        </p>
        <h2>Build quality</h2>
        <p>The handle is a handle. The lid is a lid. Both are made of plastic.</p>
        <h3>Materials</h3>
        <p>Plastic, mostly, with a steel band around the base for the look.</p>
        <h2>Verdict</h2>
        <p>It boils water. Buy it if you would like some water boiled today.</p>
        <img src="/img/kettle.webp" alt="A kettle" data-box="0,400,320,240" />
      </article>
    </main>
    <footer data-box="0,1280,1280,120">
      <nav><a href="/privacy">Privacy</a></nav>
      <p>Copyright the kettle people, all rights reserved forever.</p>
    </footer>
  </body>
</html>`;

/** h1 then h3: the skip every CMS theme produces sooner or later. */
export const SKIPPED_LEVEL = `<!doctype html>
<html lang="en">
  <body>
    <main>
      <h1>Top</h1>
      <h3>Jumped a level</h3>
      <p>Body copy under a heading that should have been an h2.</p>
    </main>
  </body>
</html>`;

/** Two h1s, and the second one skips nothing — so the two violation kinds
 * have to be reported independently of each other. */
export const TWO_H1 = `<!doctype html>
<html lang="en">
  <body>
    <main>
      <h1>First title</h1>
      <h2>A section</h2>
      <h1>Second title</h1>
    </main>
  </body>
</html>`;

/** No h1 at all, starting at h2 — common on pages where the site logo was
 * "the h1" until someone made it an image. */
export const NO_H1 = `<!doctype html>
<html lang="en">
  <body>
    <main>
      <h2>Section one</h2>
      <h2>Section two</h2>
    </main>
  </body>
</html>`;

/** Every media shape worth reporting: alt present, alt empty (decorative),
 * alt missing, a data: URI, an extension-less src, srcset-only, a JS
 * lazy-loader's data-src, and a video with no alt to have. */
export const MEDIA = `<!doctype html>
<html lang="en">
  <body>
    <main>
      <img src="/img/hero.webp" alt="A hero" data-box="0,0,1200,600" />
      <img src="/img/spacer.png" alt="" />
      <img src="/img/undescribed.JPG" />
      <img src="/img/lazy.avif" alt="Lazy" loading="lazy" />
      <img data-src="/img/deferred.png" alt="Deferred" />
      <img srcset="/img/small.jpg 480w, /img/large.jpg 1024w" alt="Responsive" />
      <img src="/render?id=7" alt="No extension" />
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Inline" />
      <video src="/media/clip.mp4" preload="none"></video>
    </main>
  </body>
</html>`;

/** Boilerplate dominates: six nav links against one sentence of body copy.
 * The split must still name main correctly, and say so confidently, because
 * the page declared the landmark however small it is. */
export const NAV_HEAVY = `<!doctype html>
<html lang="en">
  <body>
    <header data-box="0,0,1280,200">
      <nav>
        <a href="/">Home</a><a href="/pricing">Pricing</a
        ><a href="/docs">Documentation</a><a href="/blog">Blog and updates</a
        ><a href="/about">About the company</a><a href="/contact">Contact us</a>
      </nav>
    </header>
    <main data-box="0,200,800,60"><p>One short paragraph of body copy.</p></main>
    <footer data-box="0,260,1280,300">
      <nav><a href="/privacy">Privacy policy</a><a href="/terms">Terms</a></nav>
      <p>A long footer of legal text that goes on rather longer than the body.</p>
    </footer>
  </body>
</html>`;

/** No landmark anywhere: div soup with a nav, where the split has to infer
 * main from density and geometry and admit lower confidence for it. */
export const NO_LANDMARK = `<!doctype html>
<html lang="en">
  <body>
    <div class="bar" data-box="0,0,1280,60">
      <nav><a href="/">Home</a><a href="/help">Help</a></nav>
    </div>
    <div class="shell" data-box="0,60,1280,900">
      <div class="content" data-box="40,60,700,860">
        <p>
          The content block holds nearly all of the page text, which is the
          only thing that distinguishes it from the shell that wraps it.
        </p>
        <p>
          A second paragraph, so the content block clearly outweighs both the
          navigation bar above it and the thin sidebar beside it.
        </p>
      </div>
      <div class="side" data-box="760,60,200,860"><p>Related.</p></div>
    </div>
  </body>
</html>`;

/** Nothing at all. Every number must come back zero rather than NaN. */
export const EMPTY = '<!doctype html><html><body></body></html>';

/** No lang attribute and no meta locale, so only the prose can answer. */
export const UNDECLARED_SPANISH = `<!doctype html>
<html>
  <body>
    <main>
      <p>
        El agua de la ciudad no es la misma que el agua de la montaña, y por
        eso el sabor del café cambia con el lugar en el que se prepara.
      </p>
    </main>
  </body>
</html>`;

/** No lang attribute, non-Latin script: the range check answers before any
 * stopword table gets a chance to. */
export const UNDECLARED_JAPANESE = `<!doctype html>
<html>
  <body>
    <main><p>この記事は日本語で書かれています。読んでください。</p></main>
  </body>
</html>`;

/** lang absent from <html> but declared in a meta locale. */
export const META_LOCALE = `<!doctype html>
<html>
  <head><meta property="og:locale" content="fr_FR" /></head>
  <body><main><p>Bonjour le monde entier.</p></main></body>
</html>`;

/** Text, but all of it in landmarks that are boilerplate by definition: the
 * split has nothing to call main and has to say so. */
export const BOILERPLATE_ONLY = `<!doctype html>
<html lang="en">
  <body>
    <nav data-box="0,0,1280,200">
      <a href="/">Home</a><a href="/pricing">Pricing and plans</a>
    </nav>
    <footer data-box="0,200,1280,200"><p>Legal text and nothing else.</p></footer>
  </body>
</html>`;

/**
 * A real IR paired with a document that has no body — the shape a pruned or
 * mid-navigation capture hands an extractor. The document is a stub rather
 * than a parsed one because linkedom's `document.body` cannot be made null,
 * and pairing it with a populated IR is the point: the extractor must report
 * nothing rather than quietly answer from the IR alone.
 */
export function bodylessHarness(): ContentHarness {
  const built = harness(ARTICLE);
  const doc = { body: null } as unknown as Document;
  return { ...built, ctx: { ...built.ctx, doc } };
}

/** The bare unlandmarked page: one paragraph, no nav, no main. Nothing but
 * text evidence to infer from. */
export const BARE = `<!doctype html>
<html lang="en">
  <head><title>Bare</title></head>
  <body><p>Text with no links.</p></body>
</html>`;

/** Geometry is available and says the only text on the page is not laid out.
 * Here there genuinely is nothing to call main, and no landmark either. */
export const UNLAID_TEXT = `<!doctype html>
<html lang="en">
  <body>
    <div data-box="0,0,1280,200">
      <img src="/a.png" alt="A" /><img src="/b.png" alt="B" />
    </div>
    <div data-box="0,0,0,0">
      <p data-box="0,0,0,0">Collapsed text that no reader ever sees.</p>
    </div>
  </body>
</html>`;

/**
 * A measured page holding an image that genuinely occupies no space. This is
 * the case that must survive the omit-when-unmeasured rule: the collection
 * does have a layout engine, so `{w:0,h:0}` here is a measurement and a real
 * finding, not a missing one.
 */
export const ZERO_AREA_MEDIA = `<!doctype html>
<html lang="en">
  <body>
    <main data-box="0,0,1280,600">
      <img src="/img/collapsed.png" alt="Collapsed" data-box="0,0,0,0" />
      <p>A paragraph of prose, laid out, so the page has real geometry.</p>
    </main>
  </body>
</html>`;
