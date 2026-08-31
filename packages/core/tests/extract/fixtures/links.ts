import { parseHTML } from 'linkedom';
import { collectFromDocument } from '../../../src/collect.js';
import { defaultSettings } from '../../../src/settings.js';
import type { ExtractContext } from '../../../src/extract/types.js';

/**
 * The ugly cases the link graph has to survive, on one page: the same href in
 * a <nav> and in a <footer> (two zones, one target), a <nav> nested inside the
 * footer (which zone wins), a protocol-relative host, mailto/tel/javascript
 * schemes, a fragment-only href, an empty href, a duplicate, an icon-only
 * anchor with no text, and an href that no base can resolve.
 */
export const UGLY_LINKS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <title>Links</title>
    <base href="/shop/" />
  </head>
  <body>
    <header>
      <a href="/">Home</a>
      <nav>
        <a href="/pricing">Pricing</a>
        <a href="/pricing">Pricing</a>
        <a href="#main">Skip to content</a>
      </nav>
    </header>
    <main>
      <article>
        <a href="widgets" rel="NOFOLLOW Sponsored nofollow">A widget</a>
        <a href="//cdn.partner.test/asset.pdf">Datasheet</a>
        <a href="https://partner.test/a">Partner A</a>
        <a href="https://partner.test/b" rel="ugc">Partner B</a>
        <a href="http://exa mple.com/broken">Broken</a>
        <a href="javascript:void(0)">Open dialog</a>
        <a href=""><img src="/logo.png" alt="Back to top" /></a>
      </article>
      <aside>
        <a href="/related">Related</a>
      </aside>
    </main>
    <footer>
      <a href="/pricing">Pricing</a>
      <a href="mailto:hello@example.com">hello@example.com</a>
      <a href="tel:+15551234567">Call us</a>
      <nav>
        <a href="/legal">Legal</a>
      </nav>
    </footer>
    <div><a href="/orphan" aria-label="Orphan link"></a></div>
  </body>
</html>`;

/** A page with anchors that are not links (no href) and nothing else, so the
 * empty report is exercised without the trivially empty document. */
export const NO_LINKS_HTML = `<!doctype html>
<html lang="en">
  <body>
    <main><a id="top"></a><p>Nothing to follow here.</p></main>
  </body>
</html>`;

/** Layout is faked the way tests/fake-driver.ts fakes it: linkedom has no
 * layout engine, and buildRegions calls getBoundingClientRect on everything. */
function parse(html: string): Document {
  const { document } = parseHTML(html);
  let index = 0;
  for (const el of document.querySelectorAll('*')) {
    const position = index++;
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: position * 40,
        width: 800,
        height: 40,
        top: position * 40,
        left: 0,
        right: 800,
        bottom: position * 40 + 40,
      }),
    });
  }
  return document as unknown as Document;
}

export function linksContext(
  html: string,
  pageUrl = 'https://example.com/dir/page',
): ExtractContext {
  const doc = parse(html);
  const ir = collectFromDocument(doc, {
    settings: defaultSettings,
    pageUrl,
    userAgent: 'test-agent',
    viewport: { width: 1280, height: 800 },
    documentSize: { width: 1280, height: 2400 },
    devicePixelRatio: 1,
    now: () => new Date('2026-08-31T10:00:00.000Z'),
  });
  return { doc, ir };
}
