import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PageIR } from 'quick-caps-core';
import type { Handle } from 'quick-caps-core/distill';
import { CliError } from './errors.js';

export type Session = {
  url: string;
  driver: 'static' | 'playwright';
  ir: PageIR;
  page: number;
  /** Mirrors the last Distillation's hasMore, so `next` can print a clear
   * "no more content" message without re-deriving it (spec §5.2). */
  hasMore: boolean;
  handles: Record<number, Handle>;
  /** Set by `find` to the query it scored against, so `next` can keep
   * paging through the same query-scored distillation rather than
   * silently reverting to default ranking. Absent on sessions produced by
   * `open`/`do`. */
  query?: string;
  /** Set by `layout` to record that the current handles/page are a
   * region-only structural render, not a distillation — so `next` knows to
   * keep paging with renderLayout rather than silently switching to
   * distill()'s score-ranked content. Absent on sessions produced by
   * `open`/`do`/`find`. */
  renderer?: 'layout';
};

export class SessionNotFoundError extends Error {
  constructor(cwd: string) {
    super(`No session found in ${cwd} — run 'pc open <url>' first.`);
    this.name = 'SessionNotFoundError';
  }
}

function sessionDir(cwd: string): string {
  return join(cwd, '.quick-caps');
}

function sessionFilePath(cwd: string): string {
  return join(sessionDir(cwd), 'session.json');
}

/** Ensures .quick-caps/ is gitignored on first write, matching a build-output
 * directory's convention rather than a tracked artifact (spec §5.1). */
async function ensureGitignore(cwd: string): Promise<void> {
  const path = join(sessionDir(cwd), '.gitignore');
  try {
    await access(path);
  } catch {
    await writeFile(path, '*\n', 'utf8');
  }
}

export async function writeSession(
  cwd: string,
  session: Session,
): Promise<void> {
  await mkdir(sessionDir(cwd), { recursive: true });
  await ensureGitignore(cwd);
  const finalPath = sessionFilePath(cwd);
  const tmpPath = `${finalPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(session), 'utf8');
  await rename(tmpPath, finalPath);
}

export async function readSession(cwd: string): Promise<Session> {
  let raw: string;
  try {
    raw = await readFile(sessionFilePath(cwd), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SessionNotFoundError(cwd);
    }
    throw error;
  }

  try {
    return JSON.parse(raw) as Session;
  } catch (error) {
    throw new CliError(
      `Session file at ${sessionFilePath(cwd)} is unreadable (corrupt or truncated) — re-run 'pc open <url>'.`,
      { cause: error },
    );
  }
}
