import { lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Marks a directory as one this tool created, so `sweepArtifactRoot` will
 * only ever delete files from a root it can prove it owns — never from an
 * arbitrary/misconfigured directory that merely happens to exist. */
const SENTINEL_FILE = '.quickcaps-mcp-artifacts';

/** Where `pc_capture` writes files by default when the caller doesn't pass
 * an explicit outDir. Configurable so an agent host can point it at a
 * durable location instead of the OS tmpdir. */
export function resolveArtifactRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.QUICKCAPS_MCP_ARTIFACT_ROOT) return env.QUICKCAPS_MCP_ARTIFACT_ROOT;
  const suffix =
    typeof process.getuid === 'function' ? `-${process.getuid()}` : '';
  return join(tmpdir(), `quickcaps-mcp-artifacts${suffix}`);
}

/** How long a capture file is kept before the next sweep deletes it.
 * Defaults to 24h; falls back to the default on missing/invalid input
 * rather than throwing, since a bad env var shouldn't crash the server. */
export function resolveRetentionMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.QUICKCAPS_MCP_ARTIFACT_RETENTION_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_MS;
}

/** Marks `root` as ours only when doing so can't silently adopt a directory
 * someone else already put files in — e.g. a misconfigured
 * `QUICKCAPS_MCP_ARTIFACT_ROOT` pointing at `~/Documents`. The sentinel is
 * planted when `root` is freshly created, already empty, or already ours
 * (idempotent). If `root` pre-exists with other content and no sentinel,
 * it is left unmarked — permanently ineligible for `sweepArtifactRoot`,
 * on this call and every future one, even though `pc_capture` can still
 * write into it. */
export async function ensureArtifactRoot(root: string): Promise<void> {
  const existingStat = await lstat(root).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (existingStat?.isSymbolicLink()) {
    throw new Error(
      `Refusing to use ${root} as the artifact root: it is a symlink, not a real directory.`,
    );
  }

  let freshlyCreated = true;
  try {
    // Non-recursive first: distinguishes "didn't exist, we just made it"
    // (safe to claim unconditionally) from "already existed" (needs the
    // foreign-content check below) without a separate stat/readdir race.
    await mkdir(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      freshlyCreated = false;
    } else if (code === 'ENOENT') {
      // Missing parent directories — recursive create still means "we made
      // the whole chain fresh," same as the freshlyCreated case above.
      await mkdir(root, { recursive: true });
    } else {
      throw error;
    }
  }

  if (!freshlyCreated) {
    const entries = await readdir(root);
    const foreignContent = entries.some((entry) => entry !== SENTINEL_FILE);
    if (foreignContent) return;
  }

  try {
    await writeFile(join(root, SENTINEL_FILE), '', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/** Deletes regular files in `root` whose mtime is older than `maxAgeMs`.
 * Returns the deleted paths. Silently no-ops if `root` doesn't exist yet —
 * nothing to sweep on a fresh install. Not recursive: capture output is
 * flat files in one directory, not a tree.
 *
 * Refuses to touch anything unless `root` carries the sentinel file written
 * by `ensureArtifactRoot` — this confines deletion to directories this tool
 * created/marked itself, so a misconfigured `QUICKCAPS_MCP_ARTIFACT_ROOT`
 * pointing at an unrelated directory can't have its old files swept. */
export async function sweepArtifactRoot(
  root: string,
  maxAgeMs: number,
  now: number = Date.now(),
): Promise<string[]> {
  try {
    await stat(join(root, SENTINEL_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const deleted: string[] = [];
  for (const entry of entries) {
    if (entry === SENTINEL_FILE) continue;
    const path = join(root, entry);
    const info = await lstat(path);
    if (!info.isFile()) continue;
    if (now - info.mtimeMs > maxAgeMs) {
      await rm(path, { force: true });
      deleted.push(path);
    }
  }
  return deleted;
}
