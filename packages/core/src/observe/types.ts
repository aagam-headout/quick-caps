/**
 * What a host that was *watching* the page saw, in the shape core can
 * normalize without being a host itself — the same split `perf.ts` draws
 * between raw observations and a derived report.
 *
 * A `Recording` joins `logs` and `perf` as an optional `PageIR` field rather
 * than living in its own file beside the session: the session is a single
 * atomically-replaced JSON document today, and a directory of side artifacts
 * would introduce a lifecycle (orphans, cleanup, partial writes) nothing else
 * in this tool has. The caps below exist precisely so that stays affordable.
 */

// ---------------------------------------------------------------------------
// Storage policy. One block, with the reasoning beside each number, because
// three separate collectors implement against these and a literal buried in a
// host file is a number nobody can find to argue with.
// ---------------------------------------------------------------------------

/**
 * Largest single response body kept. A JSON API response that matters to an
 * agent — a cart, a search result page, a config blob — is comfortably under
 * this; past it the payload is a bundle, a sourcemap, or a data export, none
 * of which an agent reads and any one of which would spend the whole session
 * budget on its own.
 */
export const RECORDING_BODY_CAP_BYTES = 256 * 1024;

/**
 * Total kept-body bytes per session, oldest evicted first. `session.json` is
 * read and rewritten in full by every subsequent `pc` command, so this is not
 * a disk-space limit — it is the ceiling on how much slower every later call
 * gets. 2 MB of text is far more API surface than a page usually has and
 * still parses in single-digit milliseconds.
 */
export const RECORDING_TOTAL_BODY_CAP_BYTES = 2 * 1024 * 1024;

/**
 * Content-type prefixes whose bodies are worth keeping. Deliberately a
 * prefix list rather than a regex: a real `content-type` carries parameters
 * (`application/json; charset=utf-8`) and vendor suffixes
 * (`application/vnd.api+json`), and the prefix test handles both without
 * pretending to parse the header. Anything not matching is skipped as
 * `binary-type` — an image or a font body is bytes an agent cannot read.
 */
export const RECORDABLE_BODY_CONTENT_TYPES = [
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/xhtml+xml',
  'application/javascript',
  'application/x-www-form-urlencoded',
  'text/',
] as const;

// ---------------------------------------------------------------------------
// Recorded traffic
// ---------------------------------------------------------------------------

/**
 * Why a body is absent. A gap a caller can see is a fact; a gap it cannot see
 * is a lie — so every skip carries one of these rather than the body simply
 * not being there.
 *
 * `unreadable` is not in the storage policy's three: it comes from the error
 * contract, where a stream already consumed or a request aborted mid-flight
 * degrades to a recorded skip instead of failing the capture.
 */
export type BodySkipReason =
  'binary-type' | 'over-cap' | 'evicted' | 'unreadable';

export type RecordedBody =
  | {
      kept: true;
      /** Decoded text. Bodies are only kept for text-ish types, so there is
       * never a base64 branch here. */
      text: string;
      /** Size as observed, which is what the caps were spent on — not the
       * length of `text` after redaction. */
      bytes: number;
    }
  | {
      kept: false;
      reason: BodySkipReason;
      /** Observed size, where the host learned it before deciding to skip.
       * Absent for a body that was never measurable (an aborted request). */
      bytes?: number;
    };

/**
 * One response the host witnessed. A redirect chain is several of these, one
 * per hop, each with its own 3xx status — collapsing them would hide exactly
 * the thing a caller reproducing the call needs to see.
 */
export type RecordedRequest = {
  /** Milliseconds from the recording's start, matching `LogEntry.at`'s
   * page-relative convention rather than a wall clock. */
  at: number;
  method: string;
  /** Resolved absolute URL. Redacted in place on the default path, so a
   * token-bearing query parameter never reaches disk. */
  url: string;
  /** Null for a request that never got a response — aborted, or the page
   * navigated away first. */
  status: number | null;
  /** The host's own classification ('xhr', 'fetch', 'script', 'image', …),
   * passed through rather than re-derived: Playwright and the extension's
   * recorder each know more about the request than its URL reveals. */
  resourceType: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  /** Null when the request did not complete. */
  durationMs: number | null;
  /** Bytes over the wire, null when the host could not measure it. */
  transferSizeBytes: number | null;
  body: RecordedBody;
};

export type Recording = {
  /** ISO timestamp of when observation was armed, so a caller can tell a
   * recording apart from the page load it belongs to. */
  startedAt: string;
  requests: RecordedRequest[];
  /** True on the default path. False only when the caller explicitly opted
   * out, which a report must be able to say out loud — a recording nobody
   * redacted is a different artifact from one that was. */
  redacted: boolean;
  /** Running total of kept body bytes. Stored rather than re-summed so
   * appending one more request can enforce the session cap in constant time,
   * which matters when the cap's whole purpose is to bound per-call cost. */
  bodyBytes: number;
};
