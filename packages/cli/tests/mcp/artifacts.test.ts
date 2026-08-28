import { mkdtemp, rm, writeFile, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveArtifactRoot,
  resolveRetentionMs,
  ensureArtifactRoot,
  sweepArtifactRoot,
} from '../../src/mcp/artifacts.js';

describe('resolveArtifactRoot', () => {
  it('defaults to a quickcaps-mcp-artifacts dir under the OS tmpdir', () => {
    const path = resolveArtifactRoot({});
    expect(path.startsWith(join(tmpdir(), 'quickcaps-mcp-artifacts'))).toBe(
      true,
    );
  });

  it('honors QUICKCAPS_MCP_ARTIFACT_ROOT when set', () => {
    expect(
      resolveArtifactRoot({ QUICKCAPS_MCP_ARTIFACT_ROOT: '/custom/root' }),
    ).toBe('/custom/root');
  });

  it('includes the process uid in the default path when available', () => {
    const path = resolveArtifactRoot({});
    if (typeof process.getuid === 'function') {
      expect(path).toContain(String(process.getuid()));
    } else {
      // Windows has no process.getuid — the default stays the fixed name.
      expect(path).toContain('quickcaps-mcp-artifacts');
    }
  });
});

describe('resolveRetentionMs', () => {
  it('defaults to 24 hours', () => {
    expect(resolveRetentionMs({})).toBe(24 * 60 * 60 * 1000);
  });

  it('honors QUICKCAPS_MCP_ARTIFACT_RETENTION_MS when a positive number', () => {
    expect(
      resolveRetentionMs({ QUICKCAPS_MCP_ARTIFACT_RETENTION_MS: '1000' }),
    ).toBe(1000);
  });

  it('falls back to the default on garbage input', () => {
    expect(
      resolveRetentionMs({ QUICKCAPS_MCP_ARTIFACT_RETENTION_MS: 'nope' }),
    ).toBe(24 * 60 * 60 * 1000);
    expect(
      resolveRetentionMs({ QUICKCAPS_MCP_ARTIFACT_RETENTION_MS: '-5' }),
    ).toBe(24 * 60 * 60 * 1000);
  });
});

describe('sweepArtifactRoot', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'quickcaps-sweep-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('deletes files older than maxAgeMs and keeps newer ones', async () => {
    await ensureArtifactRoot(root);
    const oldFile = join(root, 'old.html');
    const newFile = join(root, 'new.html');
    await writeFile(oldFile, 'old');
    await writeFile(newFile, 'new');

    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(oldFile, oldTime, oldTime);

    const deleted = await sweepArtifactRoot(root, 60 * 60 * 1000);

    expect(deleted).toEqual([oldFile]);
    await expect(stat(newFile)).resolves.toBeDefined();
    await expect(stat(oldFile)).rejects.toThrow();
  });

  it('is a no-op on a directory that does not exist yet', async () => {
    const missing = join(root, 'does-not-exist');
    await expect(sweepArtifactRoot(missing, 1000)).resolves.toEqual([]);
  });

  it('is a no-op on a directory without the sentinel, even with old files', async () => {
    const oldFile = join(root, 'old.html');
    await writeFile(oldFile, 'old');
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(oldFile, oldTime, oldTime);

    const deleted = await sweepArtifactRoot(root, 60 * 60 * 1000);

    expect(deleted).toEqual([]);
    await expect(stat(oldFile)).resolves.toBeDefined();
  });

  it('never deletes the sentinel file itself, regardless of age', async () => {
    await ensureArtifactRoot(root);
    const sentinel = join(root, '.quickcaps-mcp-artifacts');
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(sentinel, oldTime, oldTime);

    const deleted = await sweepArtifactRoot(root, 60 * 60 * 1000);

    expect(deleted).toEqual([]);
    await expect(stat(sentinel)).resolves.toBeDefined();
  });
});

describe('ensureArtifactRoot — symlink refusal', () => {
  let parent: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'quickcaps-symlink-'));
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('refuses a root that is a symlink rather than following it', async () => {
    const { symlink, mkdir: mkdirReal } = await import('node:fs/promises');
    const realTarget = join(parent, 'real-target');
    await mkdirReal(realTarget);
    const linkPath = join(parent, 'link-to-target');
    await symlink(realTarget, linkPath, 'dir');

    await expect(ensureArtifactRoot(linkPath)).rejects.toThrow(/symlink/i);

    // The sentinel must not have been planted in the real target either.
    await expect(
      stat(join(realTarget, '.quickcaps-mcp-artifacts')),
    ).rejects.toThrow();
  });
});

describe('sweepArtifactRoot — lstat, not stat', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'quickcaps-lstat-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('never deletes a symlink entry regardless of age', async () => {
    const { symlink, writeFile: writeFileReal, utimes: utimesReal } =
      await import('node:fs/promises');
    await ensureArtifactRoot(root);

    // A target file that is new (should NOT cause the link to survive).
    const targetDir = await mkdtemp(join(tmpdir(), 'quickcaps-target-'));
    const target = join(targetDir, 'new-target.html');
    await writeFileReal(target, 'x');

    const linkPath = join(root, 'old-link.html');
    await symlink(target, linkPath);
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimesReal(linkPath, oldTime, oldTime).catch(() => {
      // utimes on a symlink follows the link on some platforms with no
      // lutimes equivalent in fs/promises — if this environment can't set
      // the link's own mtime independently, skip the strict assertion
      // below and just confirm the sweep doesn't crash on a symlink entry.
    });

    const deleted = await sweepArtifactRoot(root, 60 * 60 * 1000);
    // Symlink entries are skipped outright by the lstat-based check — never
    // deleted, regardless of age classification, and the sweep must not
    // throw on encountering one, nor delete the real target file outside root.
    expect(Array.isArray(deleted)).toBe(true);
    expect(deleted).not.toContain(linkPath);
    await expect(stat(target)).resolves.toBeDefined();

    await rm(targetDir, { recursive: true, force: true });
  });
});

describe('ensureArtifactRoot', () => {
  it('creates the directory recursively if missing', async () => {
    const root = join(
      await mkdtemp(join(tmpdir(), 'quickcaps-ensure-')),
      'nested',
      'dir',
    );
    await ensureArtifactRoot(root);
    await expect(stat(root)).resolves.toBeDefined();
    await rm(root, { recursive: true, force: true });
  });

  it('creates the sentinel file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quickcaps-ensure-'));
    await ensureArtifactRoot(root);
    await expect(
      stat(join(root, '.quickcaps-mcp-artifacts')),
    ).resolves.toBeDefined();
    await rm(root, { recursive: true, force: true });
  });

  it('is idempotent across repeated calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quickcaps-ensure-'));
    await ensureArtifactRoot(root);
    await expect(ensureArtifactRoot(root)).resolves.toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });

  it('refuses to adopt a pre-existing directory that already has other files — never plants the sentinel there', async () => {
    // Reproduces the misconfigured QUICKCAPS_MCP_ARTIFACT_ROOT scenario:
    // pointing the artifact root at a directory the user already has real
    // files in (e.g. ~/Documents) must never make that directory eligible
    // for the sweep's bulk deletion, on this call or any future one.
    const root = await mkdtemp(join(tmpdir(), 'quickcaps-ensure-'));
    const victimFile = join(root, 'important.txt');
    await writeFile(victimFile, 'do not delete me');
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(victimFile, oldTime, oldTime);

    await ensureArtifactRoot(root);

    // The sentinel must NOT have been planted — this directory pre-existed
    // with foreign content, so it's never "ours" to sweep.
    await expect(
      stat(join(root, '.quickcaps-mcp-artifacts')),
    ).rejects.toThrow();

    // Sweeping now (as pc_capture would, right after ensure) must still be
    // a no-op, and must stay a no-op on every future call too — not just
    // delayed by one.
    const firstSweep = await sweepArtifactRoot(root, 60 * 60 * 1000);
    expect(firstSweep).toEqual([]);
    await ensureArtifactRoot(root);
    const secondSweep = await sweepArtifactRoot(root, 60 * 60 * 1000);
    expect(secondSweep).toEqual([]);
    await expect(stat(victimFile)).resolves.toBeDefined();

    await rm(root, { recursive: true, force: true });
  });
});
