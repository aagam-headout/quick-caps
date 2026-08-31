import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSingleFile, buildZip, defaultSettings } from 'quick-caps-core';
import { ensurePlaywrightSession } from '../ensure-playwright.js';

export type CaptureArgs = {
  zip?: boolean;
  outDir?: string;
  /** Arms observation for this capture. Re-collects the page through a real
   * browser even when the session already has one, because a recording has to
   * be armed before the load it observes — see ensurePlaywrightSession. */
  record?: boolean;
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
  const session = await ensurePlaywrightSession(cwd, {
    record: args.record === true,
  });
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
