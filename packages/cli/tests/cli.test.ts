import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/commands/open.js', () => ({
  runOpen: vi.fn(async (args: { url: string }) => `opened ${args.url}`),
}));
vi.mock('../src/commands/next.js', () => ({
  runNext: vi.fn(async () => 'next text'),
}));
vi.mock('../src/commands/do.js', () => ({
  runDo: vi.fn(async (n: number) => `did ${n}`),
  CliError: class CliError extends Error {},
}));
vi.mock('../src/commands/read.js', () => ({
  runRead: vi.fn(async (n: number) => `read ${n}`),
}));
vi.mock('../src/commands/find.js', () => ({
  runFind: vi.fn(async (q: string) => `found ${q}`),
}));

const { dispatch } = await import('../src/cli.js');

describe('dispatch', () => {
  it('routes "open <url>" to runOpen', async () => {
    const output = await dispatch(['open', 'https://example.com']);
    expect(output).toBe('opened https://example.com');
  });

  it('routes "open <url> --static" with the flag set', async () => {
    const { runOpen } = await import('../src/commands/open.js');
    await dispatch(['open', 'https://example.com', '--static']);
    expect(runOpen).toHaveBeenCalledWith(
      { url: 'https://example.com', static: true },
      expect.any(String),
    );
  });

  it('routes "next" to runNext', async () => {
    expect(await dispatch(['next'])).toBe('next text');
  });

  it('routes "do <n>" to runDo with a parsed number', async () => {
    expect(await dispatch(['do', '7'])).toBe('did 7');
  });

  it('routes "read <n>" to runRead with a parsed number', async () => {
    expect(await dispatch(['read', '3'])).toBe('read 3');
  });

  it('routes "find <query>" to runFind, joining multi-word queries', async () => {
    expect(await dispatch(['find', 'rare', 'word'])).toBe('found rare word');
  });

  it('throws a plain error for an unknown command', async () => {
    await expect(dispatch(['bogus'])).rejects.toThrow(/Unknown command/);
  });

  it('throws a usage error when "do" gets a non-numeric argument', async () => {
    await expect(dispatch(['do', 'not-a-number'])).rejects.toThrow(/Usage/);
  });
});
