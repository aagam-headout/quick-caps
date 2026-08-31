import type { Warning } from 'quick-caps-core';
import type { ExtractDomain } from 'quick-caps-core/extract';

/**
 * The annotation every path that extracts without a live page owes its caller.
 *
 * Two paths need it — `pc data` off the stored session, and `pc crawl` off each
 * page's serialized DOM — and they degrade identically, so the fields and the
 * wording live here rather than in one of them. A gap a caller can see is a
 * fact; a gap it cannot see is a lie, and two copies of the sentence saying so
 * is one copy away from only one of them being true.
 */

/** Domains carrying fields that need per-element computed styles — natural
 * image size, fonts actually loaded, z-index and contrast. A serialized DOM has
 * no live element to compute a style from, so these run degraded and say so. */
export const NEEDS_COMPUTED_STYLE: ExtractDomain[] = ['content', 'design'];

/**
 * The warning for the requested domains that ran without computed styles, or
 * undefined when none of them did — so a caller that asked for `links` alone
 * is not told about a limitation it never met.
 *
 * `detail` is the caller's, because *why* there is no live page differs: a
 * stored session has one page it must not re-number, a crawl has a page per
 * record and no browser at all. The reason line, which names the loss, is
 * shared.
 */
export function computedStyleWarning(
  domains: readonly ExtractDomain[],
  detail: string,
): Warning | undefined {
  const degraded = NEEDS_COMPUTED_STYLE.filter((domain) =>
    domains.includes(domain),
  );
  if (degraded.length === 0) return undefined;
  return {
    phase: 'extract',
    reason: `${degraded.join(', ')}: skipped every field needing computed styles`,
    detail,
  };
}
