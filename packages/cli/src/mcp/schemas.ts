import { z } from 'zod';

/** One zod raw shape per pc_* tool, mirroring the argv parsing cli.ts
 * already does by hand for the plain CLI. These are net-new — no CLI-flag
 * schema existed before Phase D to reuse (see design-doc research). */

export const openInputSchema = {
  url: z.string().url().describe('The page URL to open and distill.'),
  static: z
    .boolean()
    .optional()
    .describe(
      'Skip the browser and fetch statically (fast path for non-SPA pages).',
    ),
};

export const doInputSchema = {
  handle: z
    .number()
    .int()
    .describe(
      'The numbered action handle to follow, from a prior open/layout/find result.',
    ),
  value: z.string().optional().describe('Value to type, for input handles.'),
};

export const readInputSchema = {
  handle: z
    .number()
    .int()
    .describe(
      'The numbered region handle to read in full, from a prior open/layout/find result.',
    ),
};

export const findInputSchema = {
  query: z
    .string()
    .min(1)
    .describe('Search query to run against the current page.'),
};

export const nextInputSchema = {};

export const layoutInputSchema = {};

export const tokensInputSchema = {};

export const scrapeInputSchema = {
  shape: z
    .string()
    .min(1)
    .describe(
      'A JSON object mapping field names to CSS selectors (and optional #attr), e.g. {"title":"h1"}.',
    ),
};

export const captureInputSchema = {
  zip: z
    .boolean()
    .optional()
    .describe('Write a zip archive instead of a single HTML file.'),
  outDir: z
    .string()
    .optional()
    .describe(
      'Directory to write the capture into. Defaults to the MCP artifact root, not the process cwd.',
    ),
};

export const dataInputSchema = {
  domains: z
    .array(z.enum(['structured', 'entities', 'content', 'design', 'links']))
    .optional()
    .describe(
      'Domains to extract. Omit for a cheap availability summary naming which domains found something, and how much.',
    ),
  url: z
    .string()
    .url()
    .optional()
    .describe(
      'Open this url first, then extract from it. Omit to use the current session.',
    ),
};
