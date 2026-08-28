import { describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

vi.mock('../../src/commands/open.js', () => ({
  runOpen: vi.fn(async (args: { url: string }) => `opened ${args.url}`),
}));
vi.mock('../../src/commands/next.js', () => ({ runNext: vi.fn(async () => 'next-out') }));
vi.mock('../../src/commands/do.js', () => ({
  runDo: vi.fn(async (handle: number) => `did ${handle}`),
}));
vi.mock('../../src/commands/read.js', () => ({
  runRead: vi.fn(async (handle: number) => `read ${handle}`),
}));
vi.mock('../../src/commands/find.js', () => ({
  runFind: vi.fn(async (query: string) => `found ${query}`),
}));
vi.mock('../../src/commands/layout.js', () => ({ runLayout: vi.fn(async () => 'layout-out') }));
vi.mock('../../src/commands/tokens.js', () => ({ runTokens: vi.fn(async () => '{"tokens":true}') }));
vi.mock('../../src/commands/scrape.js', () => ({
  runScrape: vi.fn(async (shape: string) => `scraped ${shape}`),
}));
vi.mock('../../src/commands/capture.js', () => ({
  runCapture: vi.fn(async (args: { outDir?: string }) => `Wrote ${args.outDir}/x.html (10 bytes)`),
}));

const { buildMcpServer } = await import('../../src/mcp/server.js');
const { runOpen } = await import('../../src/commands/open.js');
const { runCapture } = await import('../../src/commands/capture.js');

async function connectedClient() {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe('buildMcpServer', () => {
  it('lists all nine pc_* tools', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'pc_capture',
        'pc_do',
        'pc_find',
        'pc_layout',
        'pc_next',
        'pc_open',
        'pc_read',
        'pc_scrape',
        'pc_tokens',
      ].sort(),
    );
  });

  it('routes pc_open to runOpen with the parsed args', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'pc_open',
      arguments: { url: 'https://example.com' },
    });
    expect(runOpen).toHaveBeenCalledWith({ url: 'https://example.com', static: undefined }, expect.any(String));
    expect(result.content).toEqual([{ type: 'text', text: 'opened https://example.com' }]);
  });

  it('defaults pc_capture outDir to the artifact root, not cwd', async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: 'pc_capture', arguments: {} });
    const [args] = vi.mocked(runCapture).mock.calls.at(-1)!;
    expect(args.outDir).not.toBe(process.cwd());
    expect(args.outDir).toContain('quickcaps-mcp-artifacts');
    expect(result.content).toContainEqual(expect.objectContaining({ type: 'text' }));
  });

  it('surfaces a thrown CliError as isError instead of a protocol error', async () => {
    const { runDo } = await import('../../src/commands/do.js');
    const { CliError } = await import('../../src/errors.js');
    vi.mocked(runDo).mockRejectedValueOnce(new CliError('no such handle'));

    const client = await connectedClient();
    const result = await client.callTool({ name: 'pc_do', arguments: { handle: 999 } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'no such handle' }]);
  });
});
