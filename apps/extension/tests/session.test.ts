import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureSession } from '../src/background/session.js';

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        }),
        remove: vi.fn(async (key: string) => {
          delete store[key];
        }),
      },
    },
  };
});

describe('CaptureSession', () => {
  it('returns null when nothing is checkpointed', async () => {
    await expect(new CaptureSession().load()).resolves.toBeNull();
  });

  it('round-trips a fresh checkpoint', async () => {
    const session = new CaptureSession();
    // A real timestamp: startedAt: 1 is 1970, which the staleness window
    // correctly discards.
    await session.save({
      phase: 'fetching-assets',
      tabId: 3,
      startedAt: Date.now(),
    });
    await expect(session.load()).resolves.toMatchObject({
      phase: 'fetching-assets',
      tabId: 3,
    });
  });

  it('clears a checkpoint', async () => {
    const session = new CaptureSession();
    await session.save({ phase: 'bundling', tabId: 3, startedAt: Date.now() });
    await session.clear();
    await expect(session.load()).resolves.toBeNull();
  });

  it('treats a checkpoint older than the staleness window as absent', async () => {
    const session = new CaptureSession({ maxAgeMs: 1000, now: () => 5000 });
    await session.save({ phase: 'bundling', tabId: 3, startedAt: 1000 });
    await expect(session.load()).resolves.toBeNull();
  });

  it('keeps a checkpoint inside the staleness window', async () => {
    const session = new CaptureSession({ maxAgeMs: 10_000, now: () => 5000 });
    await session.save({ phase: 'bundling', tabId: 3, startedAt: 1000 });
    await expect(session.load()).resolves.not.toBeNull();
  });
});
