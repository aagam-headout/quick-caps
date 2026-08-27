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
};

/** executeScript resolves to a viewport by default; scrollTo ignores it. */
export function stubViewport(
  mock: ChromeMock,
  overrides: Partial<typeof VIEWPORT> = {},
): void {
  mock.scripting.executeScript.mockResolvedValue([
    { result: { ...VIEWPORT, ...overrides } },
  ]);
}
