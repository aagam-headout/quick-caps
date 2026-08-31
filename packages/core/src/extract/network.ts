import { RECORDING_TOTAL_BODY_CAP_BYTES } from '../observe/types.js';
import type { ExtractorMap, NetworkReport } from './types.js';

/**
 * The API surface behind a page: what it asked the network for and what came
 * back. Reads `ir.recording`, never `ctx.doc` — a serialized DOM has no
 * record of a request, so this domain exists only when a host was armed.
 *
 * TODO(network): implemented separately per spec. The shape below is final;
 * what is missing is the rollup over `ir.recording.requests`.
 */
export const extractNetwork: ExtractorMap['network'] = (ctx) => {
  const recording = ctx.ir.recording;
  const empty: NetworkReport = {
    // Absent recording means nobody was watching. Reported as not-recorded
    // rather than as an empty recording, because a caller acts differently on
    // "re-open with --record" than on "this page made no requests".
    recorded: recording !== undefined,
    requests: [],
    byHost: [],
    skippedByReason: {
      'binary-type': 0,
      'over-cap': 0,
      evicted: 0,
      unreadable: 0,
    },
    totals: {
      requestCount: 0,
      bodiesKept: 0,
      bodyBytes: 0,
      bodyCapBytes: RECORDING_TOTAL_BODY_CAP_BYTES,
      transferSizeBytes: 0,
    },
    containsUnredactedCredentials:
      recording !== undefined && !recording.redacted,
  };
  return empty;
};
