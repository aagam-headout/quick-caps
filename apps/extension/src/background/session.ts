import type { CapturePhase } from '../lib/messages.js';

export type Checkpoint = {
  phase: CapturePhase;
  tabId: number;
  startedAt: number;
};

const KEY = 'capture:checkpoint';

export type SessionOptions = {
  /** A checkpoint older than this is assumed dead, not resumable. */
  maxAgeMs?: number;
  now?: () => number;
};

/**
 * Phase checkpointing across service-worker death.
 *
 * The offscreen document usually keeps the worker alive through a capture, but
 * "usually" is not a guarantee. If the worker is killed mid-capture we want to
 * report a specific failure on the next run rather than stall silently.
 */
export class CaptureSession {
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(options: SessionOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? 5 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    await chrome.storage.session.set({ [KEY]: checkpoint });
  }

  async load(): Promise<Checkpoint | null> {
    const stored = (await chrome.storage.session.get(KEY)) as Record<
      string,
      Checkpoint | undefined
    >;
    const checkpoint = stored[KEY];
    if (!checkpoint) return null;
    if (this.now() - checkpoint.startedAt > this.maxAgeMs) return null;
    return checkpoint;
  }

  async clear(): Promise<void> {
    await chrome.storage.session.remove(KEY);
  }
}
