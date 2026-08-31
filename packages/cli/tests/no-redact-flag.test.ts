import { describe, expect, it, vi } from 'vitest';

/**
 * Argv routing for `--no-redact`, in its own file rather than cli.test.ts's:
 * this mocks only the two commands that take the flag, so the assertions are
 * about the flag's plumbing and nothing else.
 */
vi.mock('../src/commands/open.js', () => ({
  runOpen: vi.fn(async () => 'open text'),
}));
vi.mock('../src/commands/data.js', () => ({
  runData: vi.fn(async () => 'data text'),
}));

const { dispatch } = await import('../src/cli.js');
const { runOpen } = await import('../src/commands/open.js');
const { runData } = await import('../src/commands/data.js');

describe('--no-redact routing', () => {
  it('passes the flag through on open', async () => {
    await dispatch(['open', 'https://example.com', '--record', '--no-redact']);
    expect(runOpen).toHaveBeenCalledWith(
      {
        url: 'https://example.com',
        static: false,
        record: true,
        noRedact: true,
      },
      expect.any(String),
    );
  });

  it('is absent, not false, when not passed — so no existing caller changes shape', async () => {
    await dispatch(['open', 'https://example.com', '--record']);
    expect(runOpen).toHaveBeenCalledWith(
      { url: 'https://example.com', static: false, record: true },
      expect.any(String),
    );
  });

  it('is not mistaken for the url', async () => {
    await dispatch(['open', '--no-redact', '--record', 'https://example.com']);
    expect(runOpen).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com' }),
      expect.any(String),
    );
  });

  it('reaches the open that `pc data <url>` performs for the caller', async () => {
    await dispatch([
      'data',
      'https://example.com',
      '--network',
      '--record',
      '--no-redact',
    ]);
    expect(runData).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com',
        record: true,
        noRedact: true,
      }),
      expect.any(String),
    );
  });

  it('is documented in --help, including that it is opt-out of a default', async () => {
    const help = await dispatch(['--help']);
    expect(help).toContain('--no-redact');
    expect(help).toMatch(/redact/i);
  });
});
