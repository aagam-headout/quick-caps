/** A known, user-facing failure — cli.ts prints its message to stderr and
 * exits 1, rather than a raw stack trace. */
export class CliError extends Error {}
