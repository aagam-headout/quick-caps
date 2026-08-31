/**
 * Ceiling on how long one capture may hold the lock. Past it the next request
 * takes over.
 *
 * Nothing in the pipeline legitimately runs this long: the frame loop is
 * capped, downloads wait at most two minutes. A hold older than this means the
 * run is wedged on something that will never settle - a captureVisibleTab that
 * never came back, an offscreen document that stopped answering - and until
 * this existed the extension refused every later capture with "A capture is
 * already running" for the life of the worker, with no way out but reloading
 * the extension.
 */
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

/** Opaque holder token. Only the run that took the lock can release it. */
export type CaptureClaim = { readonly at: number };

/**
 * The single-runner guard for captures and screenshot previews. They share one
 * offscreen document, so two at once means the first to finish closes the
 * document under the second.
 */
export class CaptureLock {
  private held: CaptureClaim | null = null;

  constructor(
    private readonly staleAfterMs = DEFAULT_STALE_AFTER_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Takes the lock, or returns null if a live run holds it. Must be called
   * synchronously with the check that precedes it - two clicks in the same
   * tick would otherwise both see it free.
   */
  acquire(): CaptureClaim | null {
    const at = this.now();
    if (this.held && at - this.held.at < this.staleAfterMs) return null;
    this.held = { at };
    return this.held;
  }

  /**
   * Releases the lock if this claim still holds it. A claim that was already
   * taken over as stale releases nothing: its late `finally` must not free the
   * lock out from under the run that replaced it.
   */
  release(claim: CaptureClaim): void {
    if (this.held === claim) this.held = null;
  }

  /** How long the current holder has held it, in ms, or null if free. */
  heldForMs(): number | null {
    return this.held ? this.now() - this.held.at : null;
  }
}
