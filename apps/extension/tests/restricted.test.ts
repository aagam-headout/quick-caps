import { describe, expect, it } from 'vitest';
import { restrictionFor } from '../src/background/restricted.js';

describe('restrictionFor', () => {
  it.each([
    ['chrome://settings', 'Chrome internal pages'],
    ['edge://flags', 'Chrome internal pages'],
    ['chrome-extension://abc/popup.html', 'extension pages'],
    ['https://chromewebstore.google.com/detail/x', 'the Chrome Web Store'],
    ['https://chrome.google.com/webstore/detail/x', 'the Chrome Web Store'],
    ['view-source:https://example.com', 'view-source pages'],
    ['about:blank', 'blank and about: pages'],
    ['file:///Users/me/a.pdf', 'local files'],
  ])('%s is restricted, naming %s', (url, expected) => {
    expect(restrictionFor(url)).toContain(expected);
  });

  it.each([
    'https://example.com',
    'http://localhost:3000/app',
    'https://chrome.google.com/not-the-store',
  ])('%s is capturable', (url) => {
    expect(restrictionFor(url)).toBeNull();
  });

  it('explains rather than just refusing', () => {
    expect(restrictionFor('chrome://settings')).toMatch(/cannot be captured/i);
  });

  it('refuses an unparseable address without throwing', () => {
    expect(restrictionFor('not a url')).toMatch(/could not be read/i);
  });
});
