const RULES: { test: (url: URL) => boolean; what: string }[] = [
  {
    test: (url) => url.protocol === 'chrome:' || url.protocol === 'edge:',
    what: 'Chrome internal pages',
  },
  {
    test: (url) => url.protocol === 'chrome-extension:',
    what: 'extension pages',
  },
  { test: (url) => url.protocol === 'view-source:', what: 'view-source pages' },
  { test: (url) => url.protocol === 'about:', what: 'blank and about: pages' },
  { test: (url) => url.protocol === 'file:', what: 'local files' },
  {
    test: (url) =>
      url.hostname === 'chromewebstore.google.com' ||
      (url.hostname === 'chrome.google.com' &&
        url.pathname.startsWith('/webstore')),
    what: 'the Chrome Web Store',
  },
];

/**
 * A human-readable reason, or null when the page is capturable. The reason
 * names the category so the popup can say something specific instead of failing
 * generically - "cannot be captured" with no explanation reads as a bug.
 */
export function restrictionFor(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'This page cannot be captured: its address could not be read.';
  }
  for (const rule of RULES) {
    if (rule.test(url)) {
      return `This page cannot be captured: Chrome does not allow extensions to read ${rule.what}.`;
    }
  }
  return null;
}
