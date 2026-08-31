/** A known, user-facing failure — cli.ts prints its message to stderr and
 * exits 1, rather than a raw stack trace. */
export class CliError extends Error {}

/**
 * A response the fetch path refused, carrying the facts a caller needs to react
 * to it: the status, and the `Retry-After` header as the server wrote it.
 *
 * core's shared fetch helper throws a message-only Error, and a message is not
 * something a backoff policy can read — a status regexed back out of one is a
 * guess (`exceeds per-asset cap: declared 300 bytes` is not a 300), and a
 * `Retry-After` never survives the round trip at all. The crawler's politeness
 * prefers a server's own instruction over its exponential ladder, so the
 * instruction has to arrive intact.
 */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
    /** Verbatim, unparsed: whether it is delay-seconds or an HTTP-date is a
     * decision, and decisions live in the pure units — see
     * crawl/politeness.ts's parseRetryAfterSeconds. */
    readonly retryAfter: string | undefined,
  ) {
    // The same message core would have thrown, so a record's detail reads
    // exactly as it did before this type existed.
    super(`${status} ${statusText}`.trim());
  }
}
