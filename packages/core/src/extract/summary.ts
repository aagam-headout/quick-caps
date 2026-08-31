import type {
  DataReport,
  EntityReport,
  ExtractDomain,
  LinkReport,
  NetworkReport,
  StackReport,
  StructuredReport,
} from './types.js';
import { EXTRACT_DOMAINS } from './registry.js';

export type DomainAvailability = {
  domain: ExtractDomain;
  /** Null for a domain whose report is one whole-page summary rather than a
   * list of findings — there is nothing to count, and printing (1) would
   * imply there could have been more. Also null when `notRecorded` is set:
   * there is no count to offer, and a zero would read as a finding. */
  count: number | null;
  /** True for an observation domain whose host was never armed. Not the same
   * as a count of zero — "nothing happened" and "nobody was watching" are
   * different answers, and a caller acts on them differently. */
  notRecorded?: boolean;
};

/** The domains derived from observation rather than from the document, and
 * therefore the only ones that can come back not-recorded. */
export const OBSERVATION_DOMAINS = [
  'network',
  'stack',
  'vitals',
] as const satisfies readonly ExtractDomain[];

/** Discrete declarations, not fields: three JSON-LD nodes read as three
 * findings, while the social preview and the SEO set are each one. */
function countStructured(report: StructuredReport): number {
  const social = Object.values(report.social).some(
    (value) => value !== undefined,
  );
  const seo =
    report.seo.canonical !== undefined ||
    report.seo.alternates.length > 0 ||
    report.seo.robots.length > 0 ||
    report.seo.feeds.length > 0;
  return (
    report.jsonLd.length +
    report.microdata.length +
    report.rdfa.length +
    (social ? 1 : 0) +
    (seo ? 1 : 0)
  );
}

function countEntities(report: EntityReport): number {
  const { contacts } = report;
  return (
    report.prices.length +
    report.authors.length +
    report.ratings.length +
    report.pagination.length +
    contacts.emails.length +
    contacts.phones.length +
    contacts.addresses.length +
    contacts.socials.length +
    Object.values(report.dates).filter((date) => date !== undefined).length +
    (report.availability === undefined ? 0 : 1)
  );
}

function countLinks(report: LinkReport): number {
  return report.links.length;
}

function countNetwork(report: NetworkReport): number {
  return report.requests.length;
}

/** Detections, hosts, and cookies are each a discrete finding; the consent
 * banner is one whether it is there or not, so it is not counted. */
function countStack(report: StackReport): number {
  return (
    report.technologies.length +
    report.thirdPartyHosts.length +
    report.cookies.cookies.length
  );
}

/**
 * What the caller can see per domain, for the summary an agent reads before
 * paying for a full extraction. Only domains actually present are listed: an
 * absent key means the domain either wasn't requested or failed, and either
 * way there is nothing to offer.
 */
export function domainAvailability(
  report: Partial<DataReport>,
): DomainAvailability[] {
  const rows: DomainAvailability[] = [];
  for (const domain of EXTRACT_DOMAINS) {
    switch (domain) {
      case 'structured':
        if (report.structured) {
          rows.push({ domain, count: countStructured(report.structured) });
        }
        break;
      case 'entities':
        if (report.entities) {
          rows.push({ domain, count: countEntities(report.entities) });
        }
        break;
      case 'links':
        if (report.links) {
          rows.push({ domain, count: countLinks(report.links) });
        }
        break;
      case 'network':
        if (report.network) {
          rows.push(
            report.network.recorded
              ? { domain, count: countNetwork(report.network) }
              : { domain, count: null, notRecorded: true },
          );
        }
        break;
      case 'stack':
        if (report.stack) {
          rows.push(
            report.stack.recorded
              ? { domain, count: countStack(report.stack) }
              : { domain, count: null, notRecorded: true },
          );
        }
        break;
      case 'vitals':
        if (report.vitals) {
          rows.push(
            report.vitals.recorded
              ? { domain, count: null }
              : { domain, count: null, notRecorded: true },
          );
        }
        break;
      default:
        if (report[domain]) rows.push({ domain, count: null });
    }
  }
  return rows;
}

/**
 * The one-line form: `structured(3) entities(11) content design links(47)`.
 * A domain nobody was watching prints `network(not-recorded)` — hyphenated so
 * the line stays one space-separated token per domain.
 */
export function formatAvailability(report: Partial<DataReport>): string {
  return domainAvailability(report)
    .map((row) => {
      if (row.notRecorded === true) return `${row.domain}(not-recorded)`;
      return row.count === null ? row.domain : `${row.domain}(${row.count})`;
    })
    .join(' ');
}
