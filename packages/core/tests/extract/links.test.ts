import { describe, expect, it } from 'vitest';
import { extractLinks } from '../../src/extract/links.js';
import type { Region, Warning } from '../../src/ir.js';
import type {
  ExtractorContext,
  LinkEntry,
  LinkReport,
} from '../../src/extract/types.js';
import {
  NO_LINKS_HTML,
  UGLY_LINKS_HTML,
  linksContext,
} from './fixtures/links.js';

function run(
  html: string,
  pageUrl?: string,
): { report: LinkReport; warnings: Array<Omit<Warning, 'phase'>> } {
  const warnings: Array<Omit<Warning, 'phase'>> = [];
  const ctx: ExtractorContext = {
    ...linksContext(html, pageUrl),
    warn: (warning) => warnings.push(warning),
  };
  return { report: extractLinks(ctx), warnings };
}

/** Anchor text is the readable key here — hrefs repeat across zones on
 * purpose, so a text lookup would be ambiguous where a zone+text one is not. */
function find(report: LinkReport, text: string, zone?: string): LinkEntry {
  const matches = report.links.filter(
    (link) => link.text === text && (zone === undefined || link.zone === zone),
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

/** Every link handle the IR handed out, so the report's `handle` can be
 * checked against the real action space rather than a hardcoded number. */
function linkActionIds(regions: Region[]): number[] {
  return regions.flatMap((region) => [
    ...region.actions
      .filter((action) => action.type === 'link')
      .map((action) => action.id),
    ...linkActionIds(region.children),
  ]);
}

describe('extractLinks', () => {
  it('returns a well-formed empty report for a page with no links', () => {
    const { report, warnings } = run(NO_LINKS_HTML);

    expect(report).toEqual({
      links: [],
      internalCount: 0,
      externalCount: 0,
      byHost: {},
    });
    expect(warnings).toEqual([]);
  });

  it('reports every resolvable link in document order', () => {
    const { report } = run(UGLY_LINKS_HTML);

    // 17 anchors carry an href; the malformed one is dropped below.
    expect(report.links).toHaveLength(16);
    expect(report.links.map((link) => link.text).slice(0, 4)).toEqual([
      'Home',
      'Pricing',
      'Pricing',
      'Skip to content',
    ]);
  });

  it('resolves relative hrefs against <base href>, not the page url', () => {
    const { report } = run(UGLY_LINKS_HTML);

    expect(find(report, 'A widget').href).toBe(
      'https://example.com/shop/widgets',
    );
  });

  it('classifies internal against the page origin and tallies outbound hosts', () => {
    const { report } = run(UGLY_LINKS_HTML);

    expect(report.internalCount).toBe(10);
    expect(report.externalCount).toBe(6);
    expect(report.internalCount + report.externalCount).toBe(
      report.links.length,
    );
    expect(report.byHost).toEqual({
      'cdn.partner.test': 1,
      'partner.test': 2,
    });
    expect(find(report, 'Partner A')).toMatchObject({
      internal: false,
      host: 'partner.test',
    });
    expect(find(report, 'Related')).toMatchObject({
      internal: true,
      host: 'example.com',
    });
  });

  it('resolves a protocol-relative href against the page scheme', () => {
    const { report } = run(UGLY_LINKS_HTML);

    expect(find(report, 'Datasheet')).toMatchObject({
      href: 'https://cdn.partner.test/asset.pdf',
      internal: false,
      host: 'cdn.partner.test',
    });
  });

  it('gives the same href different zones in a nav and in a footer', () => {
    const { report } = run(UGLY_LINKS_HTML);

    const zones = report.links
      .filter((link) => link.href === 'https://example.com/pricing')
      .map((link) => link.zone);
    expect(zones).toEqual(['nav', 'nav', 'footer']);
  });

  it('takes the zone from the innermost region carrying one', () => {
    const { report } = run(UGLY_LINKS_HTML);

    // A <nav> inside the <footer>: the nearer landmark wins.
    expect(find(report, 'Legal').zone).toBe('nav');
    expect(find(report, 'Home').zone).toBe('nav');
    expect(find(report, 'A widget').zone).toBe('content');
    expect(find(report, 'Related').zone).toBe('aside');
    expect(find(report, 'Call us').zone).toBe('footer');
    expect(find(report, 'Orphan link').zone).toBe('unknown');
  });

  it('keeps rel tokens lowercased, deduplicated, and in declared order', () => {
    const { report } = run(UGLY_LINKS_HTML);

    expect(find(report, 'A widget').rel).toEqual(['nofollow', 'sponsored']);
    expect(find(report, 'Partner B').rel).toEqual(['ugc']);
    expect(find(report, 'Partner A').rel).toEqual([]);
  });

  it('keeps javascript, mailto, and tel links but leaves them hostless', () => {
    const { report } = run(UGLY_LINKS_HTML);

    for (const text of ['Open dialog', 'hello@example.com', 'Call us']) {
      expect(find(report, text)).toMatchObject({ internal: false, host: '' });
    }
    expect(find(report, 'hello@example.com').href).toBe(
      'mailto:hello@example.com',
    );
  });

  it('treats a fragment-only and an empty href as internal', () => {
    const { report } = run(UGLY_LINKS_HTML);

    expect(find(report, 'Skip to content')).toMatchObject({
      href: 'https://example.com/shop/#main',
      internal: true,
    });
    expect(find(report, 'Back to top')).toMatchObject({
      href: 'https://example.com/shop/',
      internal: true,
    });
  });

  it('warns and skips an href no base can resolve', () => {
    const { report, warnings } = run(UGLY_LINKS_HTML);

    expect(report.links.map((link) => link.text)).not.toContain('Broken');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.url).toBe('http://exa mple.com/broken');
    expect(warnings[0]?.reason).toContain('unresolvable');
  });

  it('carries the IR action handle when the link already has one', () => {
    const { report } = run(UGLY_LINKS_HTML);

    const handle = find(report, 'Pricing', 'footer').handle;
    expect(handle).toBeTypeOf('number');
    expect(linkActionIds(linksContext(UGLY_LINKS_HTML).ir.regions)).toContain(
      handle,
    );
    // The orphan sits in a collapsed wrapper, so the IR gave it no action.
    expect(find(report, 'Orphan link').handle).toBeUndefined();
  });

  it('stays silent on a link-less page even when the page url is unusable', () => {
    const { report, warnings } = run(NO_LINKS_HTML, 'not a url');

    expect(report.links).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('keeps links but classifies nothing internal when the base is unusable', () => {
    const { report, warnings } = run(UGLY_LINKS_HTML, 'not a url');

    expect(report.links).toHaveLength(17);
    expect(report.internalCount).toBe(0);
    expect(report.byHost).toEqual({});
    expect(find(report, 'A widget')).toMatchObject({
      href: 'widgets',
      host: '',
      internal: false,
    });
    expect(warnings.map((warning) => warning.reason).join(' ')).toContain(
      'page url',
    );
  });
});
