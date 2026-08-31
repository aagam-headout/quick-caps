// Narrow subpaths, not the root barrel — see background/chrome-driver.ts.
import { collectFromDocument } from 'quick-caps-core/collect';
import { buildPerfReport, type PerfReport } from 'quick-caps-core/perf';
import { redactRecording } from 'quick-caps-core/observe';
import type {
  CaptureSettings,
  CookieJar,
  LogEntry,
  PageIR,
  Recording,
  Warning,
} from 'quick-caps-core';
import type { RecorderObservations, VitalsObservation } from './recorder.js';
import {
  FLUSH_EVENT,
  IR_KEY,
  LOGS_ATTRIBUTE,
  OBSERVATIONS_ATTRIBUTE,
  SETTINGS_KEY,
} from './protocol.js';

const STYLE_PROPERTIES = [
  'color',
  'background-color',
  'border-top-color',
  'font-family',
  'font-size',
  'line-height',
  'font-weight',
  'border-radius',
  'box-shadow',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'gap',
];

/**
 * Reads the recorder's ring buffer across the world boundary.
 *
 * The recorder must run in the MAIN world - patching the ISOLATED world's
 * console and fetch would observe nothing the page does. A DOM attribute is
 * genuinely shared between worlds, so the collector asks for a flush with a
 * synchronous event and reads the result out of the attribute.
 */
export function readRecorderLogs(): LogEntry[] | undefined {
  try {
    document.dispatchEvent(new Event(FLUSH_EVENT));
    const raw = document.documentElement.getAttribute(LOGS_ATTRIBUTE);
    if (!raw) return undefined;
    document.documentElement.removeAttribute(LOGS_ATTRIBUTE);
    return JSON.parse(raw) as LogEntry[];
  } catch {
    // Logs are optional; the rest of the capture is not.
    return undefined;
  }
}

/**
 * Reads the recorder's over-time observations across the same world boundary.
 *
 * Removes both flushed attributes, not just its own: the flush rewrites the log
 * attribute too, and an attribute left on <html> would be serialized straight
 * into the captured page.
 */
export function readRecorderObservations(): RecorderObservations | undefined {
  try {
    document.dispatchEvent(new Event(FLUSH_EVENT));
    const raw = document.documentElement.getAttribute(OBSERVATIONS_ATTRIBUTE);
    document.documentElement.removeAttribute(OBSERVATIONS_ATTRIBUTE);
    document.documentElement.removeAttribute(LOGS_ATTRIBUTE);
    if (!raw) return undefined;
    return JSON.parse(raw) as RecorderObservations;
  } catch {
    // Observations are optional; the rest of the capture is not.
    return undefined;
  }
}

/**
 * The cookie inventory this surface can honestly produce, and no more.
 *
 * `document.cookie` cannot see an `HttpOnly` cookie - that is the flag's whole
 * purpose - so the jar is partial by construction and `complete: false` says
 * so. The `cookies` permission that would fix it is rejected for the same
 * reason as chrome.debugger: this extension asks for nothing at install and
 * uploads nothing, and a cookie-reading permission warning would cost far more
 * than a complete inventory is worth. `extract/stack.ts` turns that flag into a
 * warning of its own, so a reader never mistakes the subset for the whole.
 *
 * No value is read anywhere: `CookieRecord` has no value field, because the
 * value is the credential and the name is the inventory.
 */
export function readCookieJar(): CookieJar | undefined {
  try {
    const cookies: CookieJar['cookies'] = [];
    for (const pair of document.cookie.split(';')) {
      const trimmed = pair.trim();
      if (trimmed === '') continue;
      const separator = trimmed.indexOf('=');
      // The serialization is name=value; a segment without one carries no name
      // to inventory, so there is nothing to report about it.
      if (separator <= 0) continue;
      cookies.push({
        name: trimmed.slice(0, separator),
        // The document's own host. `document.cookie` never discloses the
        // Domain attribute, so this is where the cookie was readable rather
        // than where it was set - the only honest answer available here.
        domain: location.hostname,
        // Always true, and not a guess: `document.cookie` only ever exposes
        // cookies readable at the page origin.
        firstParty: true,
        // httpOnly, secure and sameSite are omitted rather than defaulted -
        // the flags are invisible from here, and a false would assert one.
      });
    }
    return { cookies, complete: false };
  } catch {
    // An opaque-origin document throws on document.cookie. No jar at all is
    // the right answer: an empty one would look like a page carrying none.
    return undefined;
  }
}

/**
 * Assembles what this surface observed into a `Recording`, or nothing when it
 * observed nothing at all - absent means "nobody was watching", which every
 * report derived from this field distinguishes from an empty recording.
 *
 * Bodies are never kept and headers are never read, so what reaches a report is
 * request metadata plus the cookie jar. Redacted on the way out, which for this
 * host is record time: a token in a query parameter is the most quotable
 * credential there is, and `redactRecording` is also what sets `redacted` so a
 * later reader never has to guess.
 */
export function buildRecording(
  observations: RecorderObservations | undefined,
): Recording | undefined {
  const cookies = readCookieJar();
  if (!observations && !cookies) return undefined;
  return redactRecording({
    // The recorder's install time is when observation was armed. Without a
    // recorder the jar was read just now, and that is all this recording says.
    startedAt: observations?.startedAt ?? new Date().toISOString(),
    requests: observations?.requests ?? [],
    ...(cookies ? { cookies } : {}),
    redacted: false,
    // No body was ever kept, so no cap was ever spent.
    bodyBytes: 0,
  });
}

/**
 * States the limit of this surface's network observation rather than letting a
 * partial request list read as a complete one. The recorder patches fetch and
 * XMLHttpRequest, which is the API traffic; a document, script, stylesheet or
 * image request never passes through either.
 */
const PARTIAL_RECORDING_WARNING: Warning = {
  phase: 'collect',
  reason: 'network observation covers only fetch and XMLHttpRequest',
  detail:
    'document, script, stylesheet, image and media requests are not recorded, no request or response headers are observed, and no response body is ever read - the rest of the capture is intact',
};

/**
 * Reads the page's own Navigation/Paint/Resource Timing entries and derives
 * a lightweight perf snapshot from them - not a Lighthouse audit.
 *
 * `largest-contentful-paint` can report more than once as bigger content
 * loads in; the last entry observed is the final value.
 */
export function readPerfMetrics(
  observed?: VitalsObservation | undefined,
): PerfReport | undefined {
  try {
    const [navigation] = performance.getEntriesByType(
      'navigation',
    ) as PerformanceNavigationTiming[];
    const paint = performance
      .getEntriesByType('paint')
      .map((entry) => ({ name: entry.name, startTime: entry.startTime }));
    const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
    const lastLcp = lcpEntries[lcpEntries.length - 1];
    const resources = (
      performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    ).map((resource) => {
      return {
        initiatorType: resource.initiatorType,
        transferSize: resource.transferSize,
      };
    });

    return buildPerfReport({
      ...(navigation
        ? {
            navigation: {
              requestStart: navigation.requestStart,
              responseStart: navigation.responseStart,
              domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
              loadEventEnd: navigation.loadEventEnd,
              transferSize: navigation.transferSize,
            },
          }
        : {}),
      paint,
      // The observed value wins: Chrome does not return
      // largest-contentful-paint from getEntriesByType at all, so the sampled
      // read above is a fallback for hosts where it does.
      ...(typeof observed?.largestContentfulPaintMs === 'number'
        ? { largestContentfulPaintMs: observed.largestContentfulPaintMs }
        : lastLcp
          ? { largestContentfulPaintMs: lastLcp.startTime }
          : {}),
      resources,
      // Spread conditionally, never defaulted. An unobserved metric has to
      // reach buildPerfReport as an absent key: a 0 here would report a page
      // nobody measured as a perfectly stable, instantly responsive one.
      ...(typeof observed?.cumulativeLayoutShift === 'number'
        ? { cumulativeLayoutShift: observed.cumulativeLayoutShift }
        : {}),
      ...(typeof observed?.interactionToNextPaintMs === 'number'
        ? { interactionToNextPaintMs: observed.interactionToNextPaintMs }
        : {}),
      ...(observed?.unsupportedEntryTypes?.length
        ? { unsupportedEntryTypes: observed.unsupportedEntryTypes }
        : {}),
    });
  } catch {
    // A perf snapshot is optional; the rest of the capture is not.
    return undefined;
  }
}

/**
 * The structural and stylistic read of the page: metadata, region tree, and the
 * computed-style tally that design tokens come from.
 *
 * The page's *content* is serialized separately by single-file-core, which is
 * far better at it than anything here would be.
 */
export function runCollector(settings: CaptureSettings): PageIR {
  const logs = settings.include.logs ? readRecorderLogs() : undefined;
  // The over-time observations feed two consumers: the perf report's vitals,
  // and the recording the stack/network reports read. Read once - the flush is
  // synchronous and re-dispatching it would rewrite the attributes this just
  // cleaned up.
  const wantsObservations = settings.include.perf || settings.include.data;
  const observations = wantsObservations
    ? readRecorderObservations()
    : undefined;
  const perf = settings.include.perf
    ? readPerfMetrics(observations?.vitals)
    : undefined;
  // Gated on the extract report, which is the only thing that reads a
  // recording: a capture that asked for neither data nor vitals should not
  // carry a cookie inventory it has no reader for.
  const recording = settings.include.data
    ? buildRecording(observations)
    : undefined;

  const ir = collectFromDocument(document, {
    settings,
    pageUrl: location.href,
    userAgent: navigator.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentSize: {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    },
    devicePixelRatio: window.devicePixelRatio,
    computedStyle: (el) => {
      const style = getComputedStyle(el);
      const out: Record<string, string> = {};
      for (const property of STYLE_PROPERTIES) {
        out[property] = style.getPropertyValue(property);
      }
      return out;
    },
    ...(logs ? { logs } : {}),
    ...(perf ? { perf } : {}),
  });

  // `recording` is attached here rather than passed to collectFromDocument,
  // whose options predate the field.
  if (!recording) return ir;
  return {
    ...ir,
    recording,
    warnings: [...ir.warnings, PARTIAL_RECORDING_WARNING],
  };
}

/**
 * Removes elements matching `selector` from the live document for the
 * duration of a capture, returning a function that puts each one back where
 * it came from.
 *
 * Real removal, not `display: none` - single-file-core is asked to keep
 * hidden elements (`removeHiddenElements: false`, see serialize.ts) so a
 * cookie banner merely hidden would still end up in the captured output. An
 * invalid selector or an empty string is a no-op rather than a thrown error:
 * one bad selector should degrade a capture, not fail it.
 */
export function applyExclusions(selector: string): () => void {
  const trimmed = selector.trim();
  if (!trimmed) return () => {};

  let matches: Element[];
  try {
    matches = Array.from(document.querySelectorAll(trimmed));
  } catch {
    return () => {};
  }

  const removed: { node: Element; parent: ParentNode; next: Node | null }[] =
    [];
  for (const node of matches) {
    const parent = node.parentNode;
    if (!parent) continue;
    removed.push({ node, parent, next: node.nextSibling });
    node.remove();
  }

  return () => {
    for (const { node, parent, next } of removed) {
      parent.insertBefore(node, next);
    }
  };
}

/**
 * Prunes the live document down to the ancestor chain of the element matching
 * `selector`, for the duration of a capture, returning a function that puts
 * everything back.
 *
 * Removes the target's ancestors' *siblings* rather than moving the target
 * itself - moving it would re-parent it under a different ancestor chain and
 * change which CSS rules and inherited computed values apply to it. Walking
 * up and pruning siblings at each level keeps its real ancestor chain intact,
 * so it renders identically to how it looked on the page.
 *
 * An empty selector, an invalid one, one matching nothing, or one matching
 * `<body>`/`<html>` itself is a no-op - same "must not fail the whole
 * capture" contract as applyExclusions.
 */
export function applySelectionRoot(selector: string): () => void {
  const trimmed = selector.trim();
  if (!trimmed) return () => {};

  let target: Element | null;
  try {
    target = document.querySelector(trimmed);
  } catch {
    return () => {};
  }
  if (
    !target ||
    target === document.body ||
    target === document.documentElement
  ) {
    return () => {};
  }

  const removed: { node: Element; parent: ParentNode; next: Node | null }[] =
    [];
  let node: Element = target;
  while (
    node.parentElement &&
    node.parentElement !== document.documentElement
  ) {
    const parent = node.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node) continue;
      removed.push({ node: sibling, parent, next: sibling.nextSibling });
      sibling.remove();
    }
    node = parent;
  }

  return () => {
    // Reverse order so each sibling's recorded `next` is still in the tree
    // (or already reinserted) by the time it's used.
    for (let i = removed.length - 1; i >= 0; i--) {
      const { node: sibling, parent, next } = removed[i]!;
      parent.insertBefore(sibling, next);
    }
  };
}

export type CollectorOutcome =
  | { status: 'running' }
  | { status: 'done'; ir: PageIR; html: string }
  | { status: 'failed'; error: string };

export type ParkDeps = {
  /** Injected so this module never imports single-file-core, which is
   * browser-only and cannot be loaded by a Node test. */
  serialize: (
    settings: CaptureSettings,
  ) => Promise<{ html: string; title: string }>;
};

/**
 * Runs both halves and parks the outcome on the ISOLATED-world global.
 *
 * Parked rather than returned for two reasons: an injected file's completion
 * value is not its result, and serialization is asynchronous. The worker polls
 * this key until the status settles.
 */
export async function parkCollectorResult(
  globals: Record<string, unknown>,
  deps: ParkDeps,
): Promise<void> {
  const settings = globals[SETTINGS_KEY] as CaptureSettings | undefined;
  if (!settings) return;

  globals[IR_KEY] = { status: 'running' } satisfies CollectorOutcome;
  // Selection root first, so an exclude selector can still strip junk out of
  // the kept subtree; restored in the opposite order.
  const restoreSelection = applySelectionRoot(settings.selectionSelector);
  const restoreExclusions = applyExclusions(settings.excludeSelector);
  try {
    const ir = runCollector(settings);
    const { html, title } = await deps.serialize(settings);
    globals[IR_KEY] = {
      status: 'done',
      ir: { ...ir, metadata: { ...ir.metadata, title } },
      html,
    } satisfies CollectorOutcome;
  } catch (error) {
    globals[IR_KEY] = {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    } satisfies CollectorOutcome;
  } finally {
    restoreExclusions();
    restoreSelection();
  }
}
