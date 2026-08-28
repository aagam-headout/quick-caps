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
vi.mock('../src/commands/layout.js', () => ({
  runLayout: vi.fn(async () => 'layout text'),
}));
vi.mock('../src/commands/tokens.js', () => ({
  runTokens: vi.fn(async () => 'tokens json'),
}));
vi.mock('../src/commands/scrape.js', () => ({
  runScrape: vi.fn(async (shape: string) => `scraped ${shape}`),
}));
vi.mock('../src/commands/capture.js', () => ({
  runCapture: vi.fn(async () => 'capture message'),
}));
vi.mock('../src/mcp/server.js', () => ({
  startMcpServer: vi.fn(async () => undefined),
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

describe('dispatch — extended commands', () => {
  it('routes "layout" to runLayout', async () => {
    expect(await dispatch(['layout'])).toBe('layout text');
  });

  it('routes "tokens" to runTokens', async () => {
    expect(await dispatch(['tokens'])).toBe('tokens json');
  });

  it('routes "scrape <shape>" to runScrape with the raw shape string', async () => {
    const { runScrape } = await import('../src/commands/scrape.js');
    await dispatch(['scrape', '{"title":"h1"}']);
    expect(runScrape).toHaveBeenCalledWith(
      '{"title":"h1"}',
      expect.any(String),
    );
  });

  it('routes "capture" to runCapture with parsed --zip and --out flags', async () => {
    const { runCapture } = await import('../src/commands/capture.js');
    await dispatch(['capture', '--zip', '--out', './somewhere']);
    expect(runCapture).toHaveBeenCalledWith(
      { zip: true, outDir: './somewhere' },
      expect.any(String),
    );
  });

  it('routes "capture" with no flags to runCapture with an empty args object', async () => {
    const { runCapture } = await import('../src/commands/capture.js');
    await dispatch(['capture']);
    expect(runCapture).toHaveBeenCalledWith({}, expect.any(String));
  });

  it('routes "do <n> <value>" to runDo with the parsed number and value', async () => {
    const { runDo } = await import('../src/commands/do.js');
    await dispatch(['do', '5', 'wireless mouse']);
    expect(runDo).toHaveBeenCalledWith(5, expect.any(String), 'wireless mouse');
  });

  it('routes "do <n>" with no value to runDo with value undefined', async () => {
    const { runDo } = await import('../src/commands/do.js');
    await dispatch(['do', '5']);
    expect(runDo).toHaveBeenCalledWith(5, expect.any(String), undefined);
  });

  it('routes "mcp" to startMcpServer and resolves an empty string', async () => {
    const { startMcpServer } = await import('../src/mcp/server.js');
    const result = await dispatch(['mcp']);
    expect(result).toBe('');
    expect(startMcpServer).toHaveBeenCalledOnce();
  });
});
