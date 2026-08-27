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
 * console and fetch would observe nothing the page does. The collector runs
 * ISOLATED, so it cannot read a MAIN-world global at all, and passing objects
 * through CustomEvent detail across worlds is not dependable.
 *
 * A DOM attribute is genuinely shared between worlds. The collector asks for a
 * flush with a synchronous event, the recorder writes JSON into the attribute
 * inside its listener, and the collector reads and clears it.
 */
export function readRecorderLogs(): LogEntry[] | undefined {
  try {
    document.dispatchEvent(new Event(FLUSH_EVENT));
    const raw = document.documentElement.getAttribute(LOGS_ATTRIBUTE);
    if (!raw) return undefined;
    document.documentElement.removeAttribute(LOGS_ATTRIBUTE);
    return JSON.parse(raw) as LogEntry[];
  } catch {
    // No recorder present, or unparseable output. Logs are optional; the rest
    // of the capture is not.
    return undefined;
  }
}

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

/**
 * Runs the collector and parks the result on the given global object.
 *
 * The result is parked rather than returned because Vite's IIFE output ends in
 * an assignment, so the injected script's completion value is not the IR. The
 * worker reads IR_KEY in a second, tiny executeScript call.
 *
 * Takes its globals as a parameter so it is testable without depending on
 * module-cache re-execution.
 */
export function parkCollectorResult(globals: Record<string, unknown>): void {
  const settings = globals[SETTINGS_KEY] as CaptureSettings | undefined;
  if (!settings) return;
  globals[IR_KEY] = runCollector(settings);
}
