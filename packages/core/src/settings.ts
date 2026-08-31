import { z } from 'zod';

export const captureSettingsSchema = z.object({
  include: z
    .object({
      html: z.boolean().default(true),
      styles: z.boolean().default(true),
      scripts: z.boolean().default(true),
      images: z.boolean().default(true),
      fonts: z.boolean().default(true),
      screenshot: z.boolean().default(false),
      tokens: z.boolean().default(false),
      metadata: z.boolean().default(true),
      logs: z.boolean().default(false),
      rawSources: z.boolean().default(false),
      /** A lightweight performance snapshot from the page's own
       * Navigation/Paint/Resource Timing entries — not a Lighthouse audit. */
      perf: z.boolean().default(false),
    })
    .prefault({}),
  scrollToLoadLazy: z.boolean().default(true),
  inertSnapshot: z.boolean().default(true),
  /**
   * Embeds a small self-contained viewer panel in single-file output so
   * whoever reopens the capture can browse the metadata/tokens/logs/raw
   * blocks that would otherwise just sit inert at the end of the document.
   * Independent of inertSnapshot: this script is Quick-Caps's own trusted
   * code, not something the captured page supplied.
   */
  embedViewer: z.boolean().default(false),
  output: z.enum(['single-file', 'zip']).default('single-file'),
  /**
   * A CSS selector for elements to drop before capture — cookie banners,
   * ads, in-page chat widgets. Empty string means no exclusion. Applied to
   * the live DOM for the duration of the capture only, then restored.
   */
  excludeSelector: z.string().default(''),
  /**
   * A CSS selector for the one element to keep, picked via the popup's
   * "Pick element" tool. Everything outside its ancestor chain is pruned
   * before capture. Empty string means capture the whole page. Set per
   * capture, not saved as a sticky preference.
   */
  selectionSelector: z.string().default(''),
  /**
   * Tokens: {host}, {date} (yyyyMMdd), {time} (HHmmss), {timestamp}
   * (date-time combined, the v1 default). Unknown tokens pass through
   * literally rather than erroring — a typo should degrade, not block a
   * capture.
   */
  filenameTemplate: z.string().default('{host}-{timestamp}'),
  limits: z
    .object({
      concurrency: z.number().int().positive().max(32).default(6),
      assetTimeoutMs: z.number().int().positive().default(10_000),
      retries: z.number().int().min(0).max(5).default(1),
      maxAssetBytes: z
        .number()
        .int()
        .positive()
        .default(5 * 1024 * 1024),
      maxTotalBytes: z
        .number()
        .int()
        .positive()
        .default(50 * 1024 * 1024),
      logRingSize: z.number().int().positive().max(5000).default(500),
    })
    .prefault({}),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
});

export type CaptureSettings = z.infer<typeof captureSettingsSchema>;

export const defaultSettings: CaptureSettings = captureSettingsSchema.parse({});

/** Throws a ZodError on invalid input. Callers surface the message. */
export function parseSettings(input: unknown): CaptureSettings {
  return captureSettingsSchema.parse(input);
}
