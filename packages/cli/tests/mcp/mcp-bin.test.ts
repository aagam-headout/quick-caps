import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '../../bin/pc.mjs');
const fixtureHtml = readFileSync(
  join(here, '../fixtures/static-article.html'),
  'utf8',
);

let server: Server;
let baseUrl: string;
let cwd: string;
let artifactRoot: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fixtureHtml);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected the test server to bind a port');
  }
  baseUrl = `http://127.0.0.1:${address.port}/`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'quick-caps-mcp-bin-'));
  artifactRoot = await mkdtemp(
    join(tmpdir(), 'quick-caps-mcp-artifacts-test-'),
  );
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(artifactRoot, { recursive: true, force: true });
});

function firstText(content: unknown): string {
  const item = (content as Array<{ text: string }>)[0];
  if (!item) throw new Error('expected at least one content item');
  return item.text;
}

async function connect(): Promise<{
  client: Client;
  transport: StdioClientTransport;
}> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [binPath, 'mcp'],
    cwd,
    env: { ...process.env, QUICK_CAPS_MCP_ARTIFACT_ROOT: artifactRoot },
  });
  const client = new Client({ name: 'e2e-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

describe('pc mcp (end-to-end over stdio)', () => {
  it('lists every pc_* tool', async () => {
    const { client, transport } = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        [
          'pc_capture',
          'pc_data',
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
    } finally {
      await transport.close();
    }
  }, 30_000);

  it('runs a real open -> layout -> scrape round trip', async () => {
    const { client, transport } = await connect();
    try {
      const openResult = await client.callTool({
        name: 'pc_open',
        arguments: { url: baseUrl },
      });
      expect(openResult.isError).toBeFalsy();
      expect(firstText(openResult.content)).toContain('A Real Article');

      const layoutResult = await client.callTool({
        name: 'pc_layout',
        arguments: {},
      });
      expect(firstText(layoutResult.content)).toMatch(/\[\d+\] \w+ \(role=/);

      const scrapeResult = await client.callTool({
        name: 'pc_scrape',
        arguments: { shape: '{"title":"h1"}' },
      });
      const scraped = JSON.parse(firstText(scrapeResult.content));
      expect(scraped.title).toBe('A Real Article');
    } finally {
      await transport.close();
    }
  }, 30_000);

  it('surfaces a bad handle as an MCP tool error, not a crash', async () => {
    const { client, transport } = await connect();
    try {
      await client.callTool({ name: 'pc_open', arguments: { url: baseUrl } });
      const result = await client.callTool({
        name: 'pc_do',
        arguments: { handle: 9999 },
      });
      expect(result.isError).toBe(true);
    } finally {
      await transport.close();
    }
  }, 30_000);

  it('writes pc_capture output under the configured artifact root', async () => {
    const { client, transport } = await connect();
    try {
      await client.callTool({ name: 'pc_open', arguments: { url: baseUrl } });
      const result = await client.callTool({
        name: 'pc_capture',
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const text = firstText(result.content);
      expect(text).toContain(artifactRoot);
      const written = await readdir(artifactRoot);
      const captureFiles = written.filter(
        (name) => name !== '.quick-caps-mcp-artifacts',
      );
      expect(captureFiles.length).toBe(1);
    } finally {
      await transport.close();
    }
  }, 30_000);
});
