import type { ExtractorMap, StackReport } from './types.js';

/**
 * What the page is built out of and who else it talks to, derived from the
 * script URLs, asset hosts, and cookies a watching host recorded. The
 * detection signatures read observation, not `ctx.doc`: a third-party host
 * that only ever appears as an XHR target leaves no mark in the markup.
 *
 * TODO(stack): implemented separately per spec. The shape below is final;
 * what is missing is the signature matching over `ir.recording`.
 */
export const extractStack: ExtractorMap['stack'] = (ctx) => {
  const recording = ctx.ir.recording;
  const empty: StackReport = {
    recorded: recording !== undefined,
    technologies: [],
    thirdPartyHosts: [],
    cookies: {
      cookies: [],
      // Conservative until a host says otherwise: claiming HttpOnly coverage
      // that was never there would present a partial inventory as a whole
      // one, which is the exact failure the extension asymmetry warns about.
      includesHttpOnly: false,
    },
    consentBanner: { present: false },
  };
  return empty;
};
