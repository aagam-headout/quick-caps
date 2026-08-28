import { describe, expect, it, vi } from 'vitest';
import { assertFetchableUrl } from '../src/url-policy.js';

describe('assertFetchableUrl', () => {
  it('allows a normal public https URL', async () => {
    await expect(
      assertFetchableUrl('https://example.com/page'),
      // example.com resolves to a real public IP via a real DNS lookup in
      // this test — acceptable for a small, infrequent test suite; if this
      // becomes flaky in CI without network access, this test should mock
      // dns.lookup instead (see the resolver-injection design below).
    ).resolves.toBeUndefined();
  });

  it('rejects a non-http(s) scheme', async () => {
    await expect(assertFetchableUrl('file:///etc/passwd')).rejects.toThrow(
      /scheme/i,
    );
    await expect(assertFetchableUrl('data:text/html,hi')).rejects.toThrow(
      /scheme/i,
    );
    await expect(assertFetchableUrl('javascript:alert(1)')).rejects.toThrow(
      /scheme/i,
    );
  });

  it('allows loopback addresses — pointing pc at your own local dev server is a legitimate use case', async () => {
    // Ruling (post-plan, mid-Task-3): the parent spec's original framing
    // treated loopback as unconditionally private. Implementing it that way
    // breaks a real, expected use case (`pc open http://localhost:3000`
    // against your own dev server) and every existing CLI test file that
    // uses a local HTTP server as a stand-in "real webpage" fixture. The
    // actual named threat (cloud metadata exfiltration, internal-network
    // pivoting) lives in link-local/RFC1918/ULA ranges, not loopback —
    // narrowing the block to exclude loopback closes the real threat
    // without the collateral damage.
    await expect(
      assertFetchableUrl('http://127.0.0.1/'),
    ).resolves.toBeUndefined();
    await expect(
      assertFetchableUrl('http://localhost/'),
    ).resolves.toBeUndefined();
  });

  it('rejects RFC1918 private ranges by literal IP', async () => {
    await expect(assertFetchableUrl('http://10.0.0.1/')).rejects.toThrow();
    await expect(assertFetchableUrl('http://192.168.1.1/')).rejects.toThrow();
    await expect(assertFetchableUrl('http://172.16.0.1/')).rejects.toThrow();
  });

  it('rejects link-local addresses (cloud metadata range) by literal IP', async () => {
    await expect(
      assertFetchableUrl('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toThrow();
  });

  it('allows IPv6 loopback but rejects unique-local by literal address', async () => {
    await expect(assertFetchableUrl('http://[::1]/')).resolves.toBeUndefined();
    await expect(assertFetchableUrl('http://[fc00::1]/')).rejects.toThrow();
  });

  it('rejects an IPv4-mapped IPv6 cloud-metadata address after URL normalization to hex groups', async () => {
    // new URL('http://[::ffff:169.254.169.254]/').hostname normalizes the
    // dotted-decimal literal to hex groups (::ffff:a9fe:a9fe) before
    // assertFetchableUrl ever sees it — a regex expecting only the dotted
    // form would never match this, letting the cloud metadata address
    // through. This is the literal-IP path (no resolver involved) so it
    // proves the fix operates on what assertFetchableUrl actually receives.
    await expect(
      assertFetchableUrl('http://[::ffff:169.254.169.254]/'),
    ).rejects.toThrow(/private|internal/i);
  });

  it('rejects an injected resolver returning an IPv4-mapped IPv6 address in hex form', async () => {
    const fakeResolve = vi.fn(async () => [
      { address: '::ffff:a9fe:a9fe', family: 6 as const },
    ]);
    await expect(
      assertFetchableUrl('https://totally-fake-host.test/', {
        resolve: fakeResolve,
      }),
    ).rejects.toThrow(/private|internal/i);
  });

  it('rejects the full fe80::/10 link-local range, not just literal fe80: prefixes', async () => {
    await expect(assertFetchableUrl('http://[febf::1]/')).rejects.toThrow();
  });

  it('rejects the deprecated fec0::/10 IPv6 site-local range', async () => {
    await expect(assertFetchableUrl('http://[fec0::1]/')).rejects.toThrow();
  });

  it('rejects the 100.64.0.0/10 CGNAT range', async () => {
    await expect(assertFetchableUrl('http://100.64.0.1/')).rejects.toThrow();
    await expect(assertFetchableUrl('http://100.100.0.1/')).rejects.toThrow();
    await expect(
      assertFetchableUrl('http://100.127.255.254/'),
    ).rejects.toThrow();
    // Just outside the range on either side — must remain allowed.
    await expect(
      assertFetchableUrl('http://100.63.255.255/'),
    ).resolves.toBeUndefined();
    await expect(
      assertFetchableUrl('http://100.128.0.1/'),
    ).resolves.toBeUndefined();
  });

  it('allows a caller-supplied resolver to be injected for deterministic testing', async () => {
    const fakeResolve = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 as const },
    ]);
    await expect(
      assertFetchableUrl('https://totally-fake-host.test/', {
        resolve: fakeResolve,
      }),
    ).resolves.toBeUndefined();
    expect(fakeResolve).toHaveBeenCalledWith('totally-fake-host.test');
  });

  it('rejects when the injected resolver returns a private address', async () => {
    const fakeResolve = vi.fn(async () => [
      { address: '10.1.2.3', family: 4 as const },
    ]);
    await expect(
      assertFetchableUrl('https://totally-fake-host.test/', {
        resolve: fakeResolve,
      }),
    ).rejects.toThrow();
  });
});
