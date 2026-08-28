import type { Viewport } from '@quickcaps/core';

/**
 * Viewport plus the size of the box that actually scrolls. When an app shell
 * scrolls an inner pane rather than the window, the pane - not the window - is
 * what bounds a scroll step and how far scrolling can go.
 */
export type PageMetrics = Viewport & {
  scrollPortWidth: number;
  scrollPortHeight: number;
};

/**
 * The functions below are injected into the page by
 * chrome.scripting.executeScript, which serializes them to source: they may
 * not reference anything outside their own parameters and page globals. They
 * live here (rather than inline at the call site) only so tests can run them
 * against a DOM.
 */

/**
 * Measures the page and, when the window is not the scroller, finds and tags
 * the element that is.
 *
 * "documentElement.scrollHeight fits in clientHeight" is not enough to decide
 * the window scrolls: an app shell that pins its layout with `overflow:
 * hidden` still reports a taller scrollHeight, so that test said "the window
 * scrolls" and every scrollTo silently did nothing - the capture stitched the
 * same unscrolled frame several times over, which looked like a page whose
 * middle repeated and whose bottom was missing. Check whether the viewport's
 * propagated overflow actually permits scrolling as well.
 */
export function measureViewport(attr: string): PageMetrics {
  const docEl = document.documentElement;
  const body = document.body;
  let root = document.querySelector(`[${attr}]`) as HTMLElement | null;
  if (!root && body) {
    // The viewport's overflow comes from <html>, or from <body> when <html>
    // leaves it `visible` - the CSS overflow propagation rule.
    const htmlOverflowY = getComputedStyle(docEl).overflowY;
    const viewportOverflowY =
      htmlOverflowY === 'visible' || htmlOverflowY === ''
        ? getComputedStyle(body).overflowY
        : htmlOverflowY;
    const windowScrolls =
      docEl.scrollHeight > docEl.clientHeight + 1 &&
      viewportOverflowY !== 'hidden' &&
      viewportOverflowY !== 'clip';
    if (!windowScrolls) {
      // App-shell layout: something other than the window scrolls, and
      // documentElement.scrollHeight cannot see that content - walk
      // candidates for the actual scroll container (largest scrollHeight that
      // overflows itself). <body> itself is a candidate too:
      // querySelectorAll('*') on it only returns descendants, so scan it
      // separately, or pages where <body> is the scroller (not an inner div)
      // fall through to the documentElement fallback and report a
      // viewport-sized document.
      // "Biggest scrollHeight wins" alone picks up unrelated scrollers (a
      // sidebar nav list, a hidden dropdown, a long off-screen panel) that
      // outscore the real content pane - none of them are what's on screen,
      // so scrolling them leaves the visible page static and every captured
      // frame identical. Require the candidate to actually cover most of the
      // viewport, so it's the pane the user is looking at.
      let best: HTMLElement | null = null;
      let bestHeight = 0;
      for (const el of [body, ...body.querySelectorAll<HTMLElement>('*')]) {
        const style = getComputedStyle(el);
        if (!/(auto|scroll)/.test(style.overflowY)) continue;
        if (el.scrollHeight <= el.clientHeight + 1) continue;
        const rect = el.getBoundingClientRect();
        if (
          rect.width < window.innerWidth * 0.5 ||
          rect.height < window.innerHeight * 0.5
        ) {
          continue;
        }
        if (el.scrollHeight > bestHeight) {
          best = el;
          bestHeight = el.scrollHeight;
        }
      }
      root = best;
      // applyScroll() runs as a separate executeScript call with no shared JS
      // state, so tag the element it needs to re-find.
      if (root) root.setAttribute(attr, '');
    }
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    documentWidth: root ? root.scrollWidth : docEl.scrollWidth,
    documentHeight: root ? root.scrollHeight : docEl.scrollHeight,
    scrollX: root ? root.scrollLeft : window.scrollX,
    scrollY: root ? root.scrollTop : window.scrollY,
    devicePixelRatio: window.devicePixelRatio,
    scrollPortWidth: root ? root.clientWidth : window.innerWidth,
    scrollPortHeight: root ? root.clientHeight : window.innerHeight,
  };
}

/**
 * Scrolls the tagged scroll root (or the window) and reports where it actually
 * landed - a request past the end, or at an element that cannot scroll at all,
 * comes back as the position that really applies, so the caller never files a
 * frame at an offset the page never reached.
 */
export function applyScroll(
  px: number,
  py: number,
  attr: string,
): { x: number; y: number } {
  const root = document.querySelector(`[${attr}]`) as HTMLElement | null;
  if (root) {
    root.scrollLeft = px;
    root.scrollTop = py;
    return { x: root.scrollLeft, y: root.scrollTop };
  }
  window.scrollTo(px, py);
  return { x: window.scrollX, y: window.scrollY };
}
