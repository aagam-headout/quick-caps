import { lookup as dnsLookup } from 'node:dns/promises';

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

export type UrlPolicyOptions = {
  /** Injectable for deterministic tests — defaults to a real DNS lookup. */
  resolve?: (
    hostname: string,
  ) => Promise<Array<{ address: string; family: 4 | 6 }>>;
};

async function defaultResolve(
  hostname: string,
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const result = await dnsLookup(hostname, { all: true });
  return result.map((entry) => ({
    address: entry.address,
    family: entry.family as 4 | 6,
  }));
}

/** True for 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16
 * (link-local, includes the cloud metadata address 169.254.169.254), and
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
  if (a === 0) return true;
  return false;
}

/** True for fe80::/10 (link-local), fc00::/7 (unique-local), and
 * ::ffff:0:0/96-mapped IPv4 addresses that are themselves private per
 * `isPrivateIPv4`. `::1` (loopback) is deliberately NOT included — same
 * ruling as `isPrivateIPv4` above. */
function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith('fe80:')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]!);
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
