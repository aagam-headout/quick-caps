// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyScroll,
  measureViewport,
} from '../src/background/page-metrics.js';

const ATTR = 'data-quickcaps-scroll-root';

/** jsdom does no layout, so every box the code reads has to be declared. */
function size(
  el: Element,
  box: {
    scrollHeight?: number;
    clientHeight?: number;
    scrollWidth?: number;
    clientWidth?: number;
    rect?: { width: number; height: number };
  },
): void {
  for (const [key, value] of Object.entries(box)) {
    if (key === 'rect') continue;
    Object.defineProperty(el, key, { value, configurable: true });
  }
  if (box.rect) {
    const rect = box.rect;
    el.getBoundingClientRect = () =>
      ({ width: rect.width, height: rect.height }) as DOMRect;
  }
}

beforeEach(() => {
  document.documentElement.removeAttribute('style');
  document.body.removeAttribute('style');
  document.body.innerHTML = '';
  window.innerWidth = 1000;
  window.innerHeight = 800;
});

describe('measureViewport', () => {
  it('measures the window when the window is what scrolls', () => {
    size(document.documentElement, {
      scrollHeight: 4000,
      clientHeight: 800,
      scrollWidth: 1000,
    });

    const view = measureViewport(ATTR);

    expect(view.documentHeight).toBe(4000);
    expect(view.scrollPortHeight).toBe(800);
    expect(document.querySelector(`[${ATTR}]`)).toBeNull();
  });

  it('finds the inner pane when the shell reports overflow it cannot scroll', () => {
    // The shape that broke: <body> pinned with overflow:hidden, so
    // documentElement still reports a tall scrollHeight while window.scrollTo
    // does nothing at all.
    document.body.style.overflowY = 'hidden';
    size(document.documentElement, { scrollHeight: 4000, clientHeight: 800 });
    document.body.innerHTML = '<main style="overflow-y: auto"></main>';
    const pane = document.querySelector('main')!;
    size(pane, {
      scrollHeight: 6000,
      clientHeight: 800,
      scrollWidth: 1000,
      rect: { width: 1000, height: 800 },
    });
    size(document.body, { scrollHeight: 800, clientHeight: 800 });

    const view = measureViewport(ATTR);

    expect(view.documentHeight).toBe(6000);
    expect(view.scrollPortHeight).toBe(800);
    expect(pane.hasAttribute(ATTR)).toBe(true);
  });

  it('reuses an already tagged scroll root without searching again', () => {
    document.body.innerHTML = `<main ${ATTR} style="overflow-y: auto"></main>`;
    const pane = document.querySelector('main')!;
    size(pane, { scrollHeight: 5000, clientHeight: 700, scrollWidth: 900 });
    size(document.documentElement, { scrollHeight: 4000, clientHeight: 800 });

    expect(measureViewport(ATTR).documentHeight).toBe(5000);
  });
});

describe('applyScroll', () => {
  it('reports the position the scroll root actually reached', () => {
    document.body.innerHTML = `<main ${ATTR}></main>`;
    const pane = document.querySelector<HTMLElement>('main')!;
    let top = 0;
    Object.defineProperty(pane, 'scrollTop', {
      configurable: true,
      get: () => top,
      // A pane at its end clamps the assignment, exactly as a real one does.
      set: (value: number) => {
        top = Math.min(value, 1200);
      },
    });

    expect(applyScroll(0, 5000, ATTR)).toEqual({ x: 0, y: 1200 });
  });
});
