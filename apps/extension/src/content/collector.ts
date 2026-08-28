import {
  buildPerfReport,
  collectFromDocument,
  type CaptureSettings,
  type LogEntry,
  type PageIR,
  type PerfReport,
} from '@quickcaps/core';
import {
  FLUSH_EVENT,
  IR_KEY,
  LOGS_ATTRIBUTE,
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
 * The recorder must run in the MAIN world — patching the ISOLATED world's
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
 * Reads the page's own Navigation/Paint/Resource Timing entries and derives
 * a lightweight perf snapshot from them — not a Lighthouse audit.
 *
 * `largest-contentful-paint` can report more than once as bigger content
 * loads in; the last entry observed is the final value.
 */
export function readPerfMetrics(): PerfReport | undefined {
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
      ...(lastLcp ? { largestContentfulPaintMs: lastLcp.startTime } : {}),
      resources,
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
  const perf = settings.include.perf ? readPerfMetrics() : undefined;

  return collectFromDocument(document, {
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
}

/**
 * Removes elements matching `selector` from the live document for the
 * duration of a capture, returning a function that puts each one back where
 * it came from.
 *
 * Real removal, not `display: none` — single-file-core is asked to keep
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
 * itself — moving it would re-parent it under a different ancestor chain and
 * change which CSS rules and inherited computed values apply to it. Walking
 * up and pruning siblings at each level keeps its real ancestor chain intact,
 * so it renders identically to how it looked on the page.
 *
 * An empty selector, an invalid one, one matching nothing, or one matching
 * `<body>`/`<html>` itself is a no-op — same "must not fail the whole
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
