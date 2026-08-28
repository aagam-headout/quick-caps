import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSingleFile, buildZip, defaultSettings } from '@quickcaps/core';
import { ensurePlaywrightSession } from '../ensure-playwright.js';

export type CaptureArgs = {
  zip?: boolean;
  outDir?: string;
};

/**
 * Writes a full archive of the current session's page to disk — the one
 * command whose result is a file, not stdout text, so the "no unbounded
 * markup" discipline every other command follows doesn't apply here; the
 * whole point of capture is a complete, self-contained archive.
 */
export async function runCapture(
  args: CaptureArgs,
  cwd: string,
): Promise<string> {
  const session = await ensurePlaywrightSession(cwd);
  const output = args.zip
    ? buildZip({
        ir: session.ir,
        settings: defaultSettings,
        html: session.ir.html,
      })
    : buildSingleFile({
        ir: session.ir,
        settings: defaultSettings,
        html: session.ir.html,
      });

  const dir = args.outDir ?? cwd;
  const path = join(dir, output.filename);
  await writeFile(path, output.bytes);
  return `Wrote ${path} (${output.bytes.byteLength} bytes)`;
}
