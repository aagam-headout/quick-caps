import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collectFromDocument } from '../../src/collect.js';
import { defaultSettings } from '../../src/settings.js';
import { fixtureDocument } from '../fake-driver.js';
import type { ExtractContext } from '../../src/extract/types.js';

/**
 * Every extractor is mocked as a spy *wrapping the real one*, so these tests
 * assert the registry's own behaviour — which domains run, in what order,
 * what happens when one throws — against real, well-formed empty reports
 * rather than against hand-written doubles that could drift from the types.
 */
vi.mock('../../src/extract/structured.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/extract/structured.js')>();
  return { extractStructured: vi.fn(actual.extractStructured) };
});
vi.mock('../../src/extract/entities.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/extract/entities.js')>();
  return { extractEntities: vi.fn(actual.extractEntities) };
});
vi.mock('../../src/extract/content.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/extract/content.js')>();
  return { extractContent: vi.fn(actual.extractContent) };
});
vi.mock('../../src/extract/design.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/extract/design.js')>();
  return { extractDesign: vi.fn(actual.extractDesign) };
});
vi.mock('../../src/extract/links.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/extract/links.js')>();
  return { extractLinks: vi.fn(actual.extractLinks) };
});

const { extractData, EXTRACT_DOMAINS } =
  await import('../../src/extract/registry.js');
const { extractStructured } = await import('../../src/extract/structured.js');
const { extractEntities } = await import('../../src/extract/entities.js');
const { extractContent } = await import('../../src/extract/content.js');
const { extractDesign } = await import('../../src/extract/design.js');
const { extractLinks } = await import('../../src/extract/links.js');

/**
 * A document with nothing for any extractor to find. The shared `static`
 * fixture cannot serve this purpose: it carries a link and a cross-origin
 * stylesheet, so a working `links` reports an entry and a working `design`
 * reports a degradation — both correct, and both indistinguishable from a
 * regression if this suite asserted emptiness against it.
 */
function bareContext(): ExtractContext {
  const { document } = parseHTML(
    '<!doctype html><html lang="en"><head><title>Bare</title></head><body><p>Text with no links.</p></body></html>',
  );
  const doc = document as unknown as Document;
  return { doc, ir: irFor(doc) };
}

function context(): ExtractContext {
  const doc = fixtureDocument('static');
  return { doc, ir: irFor(doc) };
}

function irFor(doc: Document) {
  return collectFromDocument(doc, {
    settings: defaultSettings,
    pageUrl: 'https://example.com/page',
    userAgent: 'test-agent',
    viewport: { width: 1280, height: 800 },
    documentSize: { width: 1280, height: 2400 },
    devicePixelRatio: 2,
    now: () => new Date('2026-08-31T10:00:00.000Z'),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EXTRACT_DOMAINS', () => {
  it('names all five domains', () => {
    expect([...EXTRACT_DOMAINS].sort()).toEqual([
      'content',
      'design',
      'entities',
      'links',
      'structured',
    ]);
  });
});

describe('extractData', () => {
  it('runs only the requested domains', () => {
    const report = extractData(context(), ['links']);

    expect(extractLinks).toHaveBeenCalledOnce();
    expect(extractStructured).not.toHaveBeenCalled();
    expect(extractEntities).not.toHaveBeenCalled();
    expect(extractContent).not.toHaveBeenCalled();
    expect(extractDesign).not.toHaveBeenCalled();
    expect(report.links).toBeDefined();
    expect(report.content).toBeUndefined();
  });

  it('returns a well-formed report for every domain, with no warnings', () => {
    const report = extractData(bareContext(), [...EXTRACT_DOMAINS]);

    for (const domain of EXTRACT_DOMAINS) {
      expect(report[domain]).toBeDefined();
    }
    expect(report.warnings).toEqual([]);
  });

  it('returns an empty report, not a warning, for a page with nothing to find', () => {
    const report = extractData(bareContext(), ['structured', 'links']);

    expect(report.structured?.jsonLd).toEqual([]);
    expect(report.links?.links).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  /**
   * A degradation is not a failure: the cross-origin stylesheet in the
   * `static` fixture is unreadable by design, and `design` has to say so
   * while still reporting everything the readable sheets gave it.
   */
  it('keeps a degraded domain in the report and records the reason', () => {
    const report = extractData(context(), ['design']);

    expect(report.design).toBeDefined();
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings?.[0]?.phase).toBe('extract');
    expect(report.warnings?.[0]?.detail).toContain('cdn.example.com');
  });

  it('turns a throwing extractor into an extract-phase warning without losing its siblings', () => {
    vi.mocked(extractDesign).mockImplementationOnce(() => {
      throw new Error('bad media query');
    });

    const report = extractData(context(), ['design', 'links']);

    expect(report.design).toBeUndefined();
    expect(report.links).toBeDefined();
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings?.[0]?.phase).toBe('extract');
    expect(report.warnings?.[0]?.reason).toContain('design');
    expect(report.warnings?.[0]?.detail).toContain('bad media query');
  });

  it('runs structured before entities and hands entities its report', () => {
    const report = extractData(context(), ['entities', 'structured']);

    expect(
      vi.mocked(extractStructured).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(extractEntities).mock.invocationCallOrder[0]!);
    expect(vi.mocked(extractEntities).mock.calls[0]?.[1]).toBe(
      report.structured,
    );
  });

  it('runs structured internally for entities alone, without reporting it', () => {
    const report = extractData(context(), ['entities']);

    expect(extractStructured).toHaveBeenCalledOnce();
    expect(report.entities).toBeDefined();
    expect(report.structured).toBeUndefined();
    expect(vi.mocked(extractEntities).mock.calls[0]?.[1]).toBeDefined();
  });

  it('skips entities with a warning when the structured pass it depends on throws', () => {
    vi.mocked(extractStructured).mockImplementationOnce(() => {
      throw new Error('unreadable ld+json');
    });

    const report = extractData(context(), ['entities', 'links']);

    expect(extractEntities).not.toHaveBeenCalled();
    expect(report.entities).toBeUndefined();
    expect(report.links).toBeDefined();
    expect(report.warnings?.map((w) => w.reason).join(' ')).toContain(
      'entities',
    );
  });

  it('passes the caller context through to each extractor', () => {
    const ctx = context();
    extractData(ctx, ['links']);

    const received = vi.mocked(extractLinks).mock.calls[0]?.[0];
    expect(received?.doc).toBe(ctx.doc);
    expect(received?.ir).toBe(ctx.ir);
    expect(typeof received?.warn).toBe('function');
  });
});
