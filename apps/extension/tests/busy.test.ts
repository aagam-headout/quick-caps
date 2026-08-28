import { describe, expect, it } from 'vitest';
import { CaptureLock } from '../src/background/busy.js';

/** A clock the test moves by hand, so nothing here waits on real time. */
function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('CaptureLock', () => {
  it('refuses a second run while the first holds it', () => {
    const lock = new CaptureLock();
    expect(lock.acquire()).not.toBeNull();
    expect(lock.acquire()).toBeNull();
  });

  it('frees the lock when the holder releases it', () => {
    const lock = new CaptureLock();
    const claim = lock.acquire()!;
    lock.release(claim);
    expect(lock.acquire()).not.toBeNull();
  });

  it('takes over a hold that outlived the timeout', () => {
    // The reported bug: one wedged run refused every capture afterwards until
    // the extension was reloaded.
    const time = clock();
    const lock = new CaptureLock(60_000, time.now);
    lock.acquire();
    time.advance(59_999);
    expect(lock.acquire()).toBeNull();
    time.advance(2);
    expect(lock.acquire()).not.toBeNull();
  });

  it('ignores a release from a claim that was already taken over', () => {
    const time = clock();
    const lock = new CaptureLock(60_000, time.now);
    const wedged = lock.acquire()!;
    time.advance(60_001);
    lock.acquire();
    // The wedged run finally unblocks and runs its `finally`; the run that
    // replaced it still holds the lock.
    lock.release(wedged);
    expect(lock.acquire()).toBeNull();
  });

  it('reports how long the current run has held it', () => {
    const time = clock();
    const lock = new CaptureLock(60_000, time.now);
    expect(lock.heldForMs()).toBeNull();
    const claim = lock.acquire()!;
    time.advance(1_500);
    expect(lock.heldForMs()).toBe(1_500);
    lock.release(claim);
    expect(lock.heldForMs()).toBeNull();
  });
});
