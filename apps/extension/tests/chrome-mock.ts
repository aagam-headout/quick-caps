import { vi } from 'vitest';

/**
 * Chrome API surface used by the background context. Extension tests may mock
 * chrome.* — that boundary is what they exist to test. packages/core may not,
 * and does not.
 */
export type ChromeMock = {
  scripting: { executeScript: ReturnType<typeof vi.fn> };
  tabs: {
    captureVisibleTab: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  };
  runtime: { lastError: { message: string } | undefined };
};

export function installChromeMock(): ChromeMock {
  const mock: ChromeMock = {
    scripting: { executeScript: vi.fn() },
    tabs: {
      captureVisibleTab: vi.fn(),
      get: vi.fn(),
      query: vi.fn(),
    },
    runtime: { lastError: undefined },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = mock;
  return mock;
}

const VIEWPORT = {
  width: 1000,
  height: 500,
  documentWidth: 1000,
  documentHeight: 1200,
  scrollX: 0,
  scrollY: 0,
  devicePixelRatio: 1,
  scrollPortWidth: 1000,
  scrollPortHeight: 500,
};

/**
 * executeScript resolves to a viewport by default; scrollTo ignores it (and
 * so falls back to the offset it asked for).
 *
 * The scroll port defaults to the window: a page that scrolls its own window
 * has no separate pane, and a test overriding the viewport size means the
 * whole window, not a window with a stale pane inside it.
 */
export function stubViewport(
  mock: ChromeMock,
  overrides: Partial<typeof VIEWPORT> = {},
): void {
  const view = { ...VIEWPORT, ...overrides };
  mock.scripting.executeScript.mockResolvedValue([
    {
      result: {
        ...view,
        scrollPortWidth: overrides.scrollPortWidth ?? view.width,
        scrollPortHeight: overrides.scrollPortHeight ?? view.height,
      },
    },
  ]);
}

/**
 * A page whose scrolling actually has an end: scroll calls come back clamped
 * to maxScrollY, the way a real scroll root reports where it landed.
 */
export function stubScrollingPage(
  mock: ChromeMock,
  options: {
    viewport?: Partial<typeof VIEWPORT>;
    maxScrollY: number;
  },
): void {
  const overrides = options.viewport ?? {};
  const view = { ...VIEWPORT, ...overrides };
  const result = {
    ...view,
    scrollPortWidth: overrides.scrollPortWidth ?? view.width,
    scrollPortHeight: overrides.scrollPortHeight ?? view.height,
  };
  mock.scripting.executeScript.mockImplementation(
    async (injection: { args?: unknown[] }) => {
      // scrollTo passes [x, y, attr]; measuring and tag cleanup pass [attr].
      if (injection.args?.length === 3) {
        const y = injection.args[1] as number;
        return [{ result: { x: 0, y: Math.min(y, options.maxScrollY) } }];
      }
      return [{ result }];
    },
  );
}
