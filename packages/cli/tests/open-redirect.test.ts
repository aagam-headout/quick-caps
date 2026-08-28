import { describe, expect, it, vi } from 'vitest';

/**
 * Isolated from open.test.ts (which relies on a real chromium instance for
 * its escalation tests) because this file mocks the entire `playwright`
 * module to simulate a page that lands somewhere other than the URL it was
 * given — the only way to exercise the *post*-navigation
 * `assertFetchableUrl(page.url())` check deterministically, without
 * depending on network reachability of a private/link-local address in
 * CI.
 *
 * Regression coverage for Important finding #6: collectViaPlaywrightFor
 * re-validates the URL Playwright actually landed on after page.goto (a
 * redirect can carry the request to a private/internal address that the
 * pre-navigation check on the original URL never saw).
 */
const gotoMock = vi.fn(async () => undefined);
const pageUrlMock = vi.fn(() => 'http://169.254.169.254/redirected');
const closeMock = vi.fn(async () => undefined);

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(async () => ({
      newPage: vi.fn(async () => ({
        goto: gotoMock,
        url: pageUrlMock,
      })),
      close: closeMock,
    })),
  },
}));

const { collectViaPlaywrightFor } = await import('../src/open.js');

describe('collectViaPlaywrightFor post-navigation check', () => {
  it('rejects when the page redirects to a private/internal address, even though the original URL was public', async () => {
    await expect(
      collectViaPlaywrightFor('https://example.com/redirects-to-metadata'),
    ).rejects.toThrow(/private|internal/i);

    expect(gotoMock).toHaveBeenCalledWith(
      'https://example.com/redirects-to-metadata',
    );
    expect(pageUrlMock).toHaveBeenCalled();
    // The browser must still be closed even though the post-nav check
    // throws — the `finally` block around browser.close() must run.
    expect(closeMock).toHaveBeenCalled();
  });
});
