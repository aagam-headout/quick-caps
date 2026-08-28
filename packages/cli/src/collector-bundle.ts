import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

/**
 * Bundles collector-entry.ts — and through it, collectFromDocument,
 * buildRegions, and tallyComputedStyles — into one zero-import IIFE
 * string that assigns `globalThis.__quickcapsCollect`. Built once per CLI
 * process and cached in memory: the bundle's content never changes within
 * a process, so re-bundling per `page.evaluate` call would be pure waste.
 * Mirrors apps/extension/src/content/collector.ts's proven zero-import-
 * bundle approach (there, Vite bundles the content script at build time;
 * here, esbuild bundles it at CLI-process start time, since there is no
 * separate build step for this workspace-internal tool).
 */
export async function collectorBundleSource(): Promise<string> {
  if (cached !== null) return cached;

  const entry = fileURLToPath(new URL('./collector-entry.ts', import.meta.url));
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
  });

  const output = result.outputFiles[0];
  if (!output) {
    throw new Error('esbuild produced no output for collector-entry.ts');
  }
  cached = output.text;
  return cached;
}
