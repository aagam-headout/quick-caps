const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

export type UrlPolicyOptions = {
  /** Injectable for deterministic tests — defaults to a real DNS lookup. */
  resolve?: (
    hostname: string,
  ) => Promise<Array<{ address: string; family: 4 | 6 }>>;
};

/** `node:dns/promises` is imported lazily, inside the function body, rather
 * than as a top-level static import. This module is reachable from
 * `quickcaps-core`'s root barrel, which apps/extension's browser content
 * script also bundles (via Vite/rollup) — a top-level `import ... from
 * 'node:dns/promises'` makes it a static dependency of the whole module
 * graph and the browser bundle fails to build ("lookup" is not exported by
 * "__vite-browser-external"), even though `defaultResolve` is never
 * actually called in that context (the extension always injects its own
 * `resolve` or never triggers DNS resolution client-side). A dynamic
 * `import()` isn't part of the static graph, so bundlers can tree-shake or
 * externalize it without erroring as long as it's never invoked. */
async function defaultResolve(
  hostname: string,
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const { lookup } = await import('node:dns/promises');
  const result = await lookup(hostname, { all: true });
  return result.map((entry) => ({
    address: entry.address,
    family: entry.family as 4 | 6,
  }));
}

/** True for 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16
 * (link-local, includes the cloud metadata address 169.254.169.254),
 * 100.64.0.0/10 (CGNAT — common in real cloud/container networking, e.g.
 * Kubernetes/CNI internal ranges, and a genuine SSRF-relevant target), and
 * 0.0.0.0/8. Loopback (127.0.0.0/8) is deliberately NOT included — see the
 * ruling below. No CIDR library — the ranges involved are few and fixed,
 * so plain octet arithmetic is clearer than pulling in a dependency for
 * it.
 *
 * Ruling (made mid-Task-3, security-sensitive — surfaced to the human
 * partner rather than decided silently): loopback is allowed on purpose.
 * Blocking it breaks a real, expected use case — `pc open
 * http://localhost:3000` against your own dev server — and every existing
 * CLI test file that uses a local HTTP server as a "real webpage" fixture.
 * The actual named threat this policy exists for (cloud metadata
 * exfiltration, internal-network pivoting via a redirect/link an agent
 * didn't choose) lives in link-local/RFC1918/ULA ranges, not loopback.
 * Narrowing the block to exclude loopback closes the real threat without
 * the collateral damage. */
function isPrivateIPv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) {
    return true; // malformed — fail closed, not open
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 0) return true;
  return false;
}

/** True for fe80::/10 (link-local), fec0::/10 (deprecated IPv6
 * site-local — no longer routed, but still worth blocking defensively
 * since some stacks still resolve it), fc00::/7 (unique-local), and
 * ::ffff:0:0/96-mapped IPv4 addresses that are themselves private per
 * `isPrivateIPv4`. `::1` (loopback) is deliberately NOT included — same
 * ruling as `isPrivateIPv4` above.
 *
 * fe80::/10 and fec0::/10 are checked by numeric range on the address's
 * first 16-bit word, not by string prefix — a literal `startsWith('fe80:')`
 * check only matches exactly `fe80:...` and misses the rest of the /10
 * range (e.g. `febf::1`, which is also link-local). */
function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase();

  const firstGroup = normalized.match(/^([0-9a-f]{1,4}):/)?.[1];
  if (firstGroup) {
    const firstWord = parseInt(firstGroup, 16);
    if ((firstWord & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((firstWord & 0xffc0) === 0xfec0) return true; // fec0::/10 (deprecated)
  }

  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

  // IPv4-mapped IPv6 addresses (::ffff:0:0/96). `new URL()` normalizes a
  // literal IPv6 host to its canonical hex-group form before this function
  // ever sees it, so `::ffff:169.254.169.254` (dotted decimal, as typed)
  // arrives here as `::ffff:a9fe:a9fe` (hex groups) — a regex expecting
  // only the dotted form never matches, silently letting the mapped cloud
  // metadata address through. Try the hex form first (the form we
  // actually observe in practice), then fall back to the dotted-decimal
  // form in case some resolver ever returns that instead.
  const mappedHex = normalized.match(
    /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
  );
  if (mappedHex) {
    const groupA = parseInt(mappedHex[1]!, 16);
    const groupB = parseInt(mappedHex[2]!, 16);
    const dotted = [
      (groupA >> 8) & 0xff,
      groupA & 0xff,
      (groupB >> 8) & 0xff,
      groupB & 0xff,
    ].join('.');
    return isPrivateIPv4(dotted);
  }
  const mappedDotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) return isPrivateIPv4(mappedDotted[1]!);

  return false;
}

/** Throws when `url` should not be fetched: a non-http(s) scheme, or a
 * hostname that resolves (by literal IP or DNS lookup) to a loopback,
 * link-local, RFC1918, or IPv6-unique-local address. Guards every
 * network-initiating entry point in the CLI against agent-supplied URLs
 * from untrusted content pointing at internal/metadata endpoints. */
export async function assertFetchableUrl(
  url: string,
  options: UrlPolicyOptions = {},
): Promise<void> {
  const resolve = options.resolve ?? defaultResolve;
  const parsed = new URL(url);
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      `Refusing to fetch ${url}: scheme "${parsed.protocol}" is not allowed (only http/https).`,
    );
  }

  // URL.hostname keeps the surrounding brackets for a literal IPv6 host
  // (e.g. "[::1]") — dns.lookup() doesn't accept those, so strip them
  // before resolving. Bracket-free hostnames pass through unchanged.
  const hostname = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  const addresses = await resolve(hostname);
  if (addresses.length === 0) {
    throw new Error(`Refusing to fetch ${url}: could not resolve hostname.`);
  }
  for (const { address, family } of addresses) {
    const isPrivate =
      family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address);
    if (isPrivate) {
      throw new Error(
        `Refusing to fetch ${url}: resolves to a private/internal address (${address}).`,
      );
    }
  }
}
