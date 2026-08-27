import {
  collectFromDocument,
  type CaptureSettings,
  type LogEntry,
  type PageIR,
} from '@page-capture/core';
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
 * The structural and stylistic read of the page: metadata, region tree, and the
 * computed-style tally that design tokens come from.
 *
 * The page's *content* is serialized separately by single-file-core, which is
 * far better at it than anything here would be.
 */
export function runCollector(settings: CaptureSettings): PageIR {
  const logs = settings.include.logs ? readRecorderLogs() : undefined;

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
  });
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
  }
}
