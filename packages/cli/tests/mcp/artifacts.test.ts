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
    expect(resolveArtifactRoot({})).toBe(
      join(tmpdir(), 'quickcaps-mcp-artifacts'),
    );
  });

  it('honors QUICKCAPS_MCP_ARTIFACT_ROOT when set', () => {
    expect(
      resolveArtifactRoot({ QUICKCAPS_MCP_ARTIFACT_ROOT: '/custom/root' }),
    ).toBe('/custom/root');
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
