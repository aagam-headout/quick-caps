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

// ---------------------------------------------------------------------------
// The cookie jar
// ---------------------------------------------------------------------------

/**
 * One cookie as the host saw it. No `value` field, deliberately: the value is
 * the credential, and this type exists so `stack` can inventory *which*
 * cookies a page carries without any host ever putting a session token in the
 * IR. Every field here is metadata a reader needs and an attacker cannot use.
 *
 * Declared here rather than beside the report that consumes it because it is
 * now on both sides of the boundary — a host fills it from its jar, and
 * `extract/types.ts` re-exports it under the same name for the report.
 */
export type CookieRecord = {
  name: string;
  domain: string;
  /** ISO expiry. Absent for a session cookie, which is a different thing from
   * one that expires at an unknown time. */
  expires?: string;
  /** Against the page origin, not against the cookie's own domain. */
  firstParty: boolean;
  /** Absent when the host could not see the flag at all — see
   * `CookieJar.complete`. */
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
};

/**
 * The jar as it stood, read by a host that can read one.
 *
 * This closes a gap `Set-Cookie` observation cannot: a recorded response only
 * shows cookies the page set *during* the recording, never the jar it arrived
 * with — the logged-in session, the consent record, the returning-visitor id.
 * Those are the interesting ones, and no amount of watching the network
 * reveals them.
 *
 * The two fields are one object rather than two fields on `Recording` so they
 * cannot drift apart: a jar whose completeness nobody stated is worse than no
 * jar, because a reader would take the subset for the whole.
 */
export type CookieJar = {
  cookies: CookieRecord[];
  /**
   * True only when the host read the real jar and can therefore see
   * `HttpOnly` cookies — the CLI, via Playwright's browser context. False is
   * the extension's permanent case: `document.cookie` cannot see `HttpOnly`
   * by definition, and the `cookies` permission that would fix it is
   * explicitly rejected in the design. A false here means the absence of a
   * cookie proves nothing.
   */
  complete: boolean;
};

export type Recording = {
  /** ISO timestamp of when observation was armed, so a caller can tell a
   * recording apart from the page load it belongs to. */
  startedAt: string;
  requests: RecordedRequest[];
  /** The host's cookie jar, where the host could read one. Absent — not an
   * empty jar — when nobody looked, which is a different fact from a page
   * that genuinely carries no cookies. */
  cookies?: CookieJar;
  /** True on the default path. False only when the caller explicitly opted
   * out, which a report must be able to say out loud — a recording nobody
   * redacted is a different artifact from one that was. */
  redacted: boolean;
  /** Running total of kept body bytes. Stored rather than re-summed so
   * appending one more request can enforce the session cap in constant time,
   * which matters when the cap's whole purpose is to bound per-call cost. */
  bodyBytes: number;
};
