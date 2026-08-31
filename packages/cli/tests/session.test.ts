import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readSession,
  SessionNotFoundError,
  writeSession,
  type Session,
} from '../src/session.js';

let cwd: string;

const sampleSession: Session = {
  url: 'https://example.com/',
  driver: 'static',
  ir: {
    metadata: {
      url: 'https://example.com/',
      title: '',
      capturedAt: '2026-08-28T00:00:00.000Z',
      viewport: { width: 0, height: 0 },
      documentSize: { width: 0, height: 0 },
      devicePixelRatio: 1,
      userAgent: 'test',
      charset: 'utf-8',
      meta: {},
    },
    html: '<html></html>',
    regions: [],
    styles: [],
    assets: [],
    styleTally: {
      color: {},
      backgroundColor: {},
      borderColor: {},
      fontFamily: {},
      fontSize: {},
      lineHeight: {},
      fontWeight: {},
      spacing: {},
      borderRadius: {},
      boxShadow: {},
    },
    warnings: [],
  },
  page: 0,
  hasMore: false,
  handles: {},
};

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'quick-caps-session-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('session', () => {
  it('throws SessionNotFoundError when nothing has been written yet', async () => {
    await expect(readSession(cwd)).rejects.toThrow(SessionNotFoundError);
  });

  it('round-trips a written session', async () => {
    await writeSession(cwd, sampleSession);
    const read = await readSession(cwd);
    expect(read).toEqual(sampleSession);
  });

  it('creates a .gitignore in .quick-caps/ on first write', async () => {
    await writeSession(cwd, sampleSession);
    const gitignore = await readFile(
      join(cwd, '.quick-caps', '.gitignore'),
      'utf8',
    );
    expect(gitignore).toContain('*');
  });

  it('overwrites the previous session on a second write', async () => {
    await writeSession(cwd, sampleSession);
    await writeSession(cwd, { ...sampleSession, page: 3 });
    const read = await readSession(cwd);
    expect(read.page).toBe(3);
  });
});
