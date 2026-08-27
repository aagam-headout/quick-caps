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
    })
    .default({}),
  scrollToLoadLazy: z.boolean().default(true),
  inertSnapshot: z.boolean().default(true),
  output: z.enum(['single-file', 'zip']).default('single-file'),
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
    .default({}),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
});

export type CaptureSettings = z.infer<typeof captureSettingsSchema>;

export const defaultSettings: CaptureSettings = captureSettingsSchema.parse({});

/** Throws a ZodError on invalid input. Callers surface the message. */
export function parseSettings(input: unknown): CaptureSettings {
  return captureSettingsSchema.parse(input);
}
