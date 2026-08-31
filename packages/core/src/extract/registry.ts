import type { Warning } from '../ir.js';
import type {
  DataReport,
  ExtractContext,
  ExtractDomain,
  ExtractorContext,
  ExtractorMap,
  StructuredReport,
} from './types.js';
import { extractStructured } from './structured.js';
import { extractEntities } from './entities.js';
import { extractContent } from './content.js';
import { extractDesign } from './design.js';
import { extractLinks } from './links.js';

/** Canonical domain order — the order reports and the availability summary
 * are rendered in, so output is stable whatever order the caller asked in. */
export const EXTRACT_DOMAINS = [
  'structured',
  'entities',
  'content',
  'design',
  'links',
] as const satisfies readonly ExtractDomain[];

const extractors: ExtractorMap = {
  structured: extractStructured,
  entities: extractEntities,
  content: extractContent,
  design: extractDesign,
  links: extractLinks,
};

/**
 * Composes the requested extractors over one context. An unrequested domain
 * costs nothing — it is never called — and a domain that throws costs only
 * itself: the boundary here turns the throw into an extract-phase warning and
 * an absent key, because a malformed JSON-LD block is normal on the real web
 * and must not take the other four domains down with it.
 */
export function extractData(
  ctx: ExtractContext,
  domains: ExtractDomain[],
): Partial<DataReport> {
  const requested = new Set(domains);
  const warnings: Warning[] = [];
  // Filled domain-first and given its warnings at the end, so the printed
  // report leads with what the caller asked for.
  const report: Partial<DataReport> = {};

  const contextFor = (domain: ExtractDomain): ExtractorContext => ({
    ...ctx,
    warn: (warning) =>
      warnings.push({
        ...warning,
        phase: 'extract',
        reason: `${domain}: ${warning.reason}`,
      }),
  });

  function guarded<T>(domain: ExtractDomain, run: () => T): T | undefined {
    try {
      return run();
    } catch (error) {
      warnings.push({
        phase: 'extract',
        reason: `${domain}: extractor failed`,
        detail: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  // structured feeds entities its high-confidence tier, so it runs first
  // whether or not the caller asked to see it — and stays out of the output
  // when they didn't.
  let structured: StructuredReport | undefined;
  if (requested.has('structured') || requested.has('entities')) {
    structured = guarded('structured', () =>
      extractors.structured(contextFor('structured')),
    );
    if (requested.has('structured') && structured !== undefined) {
      report.structured = structured;
    }
  }

  if (requested.has('entities')) {
    if (structured === undefined) {
      warnings.push({
        phase: 'extract',
        reason: 'entities: skipped',
        detail:
          'the structured pass it reads for declared values failed, and guessing without it would report every value as low confidence',
      });
    } else {
      const declared = structured;
      const entities = guarded('entities', () =>
        extractors.entities(contextFor('entities'), declared),
      );
      if (entities !== undefined) report.entities = entities;
    }
  }

  // Spelled out rather than looped: a loop over the remaining domains needs a
  // cast to assign into Partial<DataReport>, and the cast is a worse trade
  // than three near-identical blocks.
  if (requested.has('content')) {
    const content = guarded('content', () =>
      extractors.content(contextFor('content')),
    );
    if (content !== undefined) report.content = content;
  }
  if (requested.has('design')) {
    const design = guarded('design', () =>
      extractors.design(contextFor('design')),
    );
    if (design !== undefined) report.design = design;
  }
  if (requested.has('links')) {
    const links = guarded('links', () => extractors.links(contextFor('links')));
    if (links !== undefined) report.links = links;
  }

  report.warnings = warnings;
  return report;
}
