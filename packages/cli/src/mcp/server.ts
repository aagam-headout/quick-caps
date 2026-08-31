import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runOpen } from '../commands/open.js';
import { runNext } from '../commands/next.js';
import { runDo } from '../commands/do.js';
import { runRead } from '../commands/read.js';
import { runFind } from '../commands/find.js';
import { runLayout } from '../commands/layout.js';
import { runTokens } from '../commands/tokens.js';
import { runScrape } from '../commands/scrape.js';
import { runData } from '../commands/data.js';
import { runCapture } from '../commands/capture.js';
import { toToolResult } from './tool-result.js';
import {
  openInputSchema,
  doInputSchema,
  readInputSchema,
  findInputSchema,
  nextInputSchema,
  layoutInputSchema,
  tokensInputSchema,
  scrapeInputSchema,
  dataInputSchema,
  captureInputSchema,
} from './schemas.js';
import {
  resolveArtifactRoot,
  resolveRetentionMs,
  ensureArtifactRoot,
  sweepArtifactRoot,
} from './artifacts.js';

/** Builds the MCP server with every pc_* tool registered, wired straight to
 * the Phase C command functions — same functions cli.ts's dispatch() calls,
 * same cwd-scoped session file on disk, so a `pc open` in a shell and a
 * pc_open tool call in the same directory share state. No transport
 * attached here so tests can drive it in-process (InMemoryTransport). */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'quick-caps-pc', version: '1.0.0' });
  const cwd = process.cwd();

  server.registerTool(
    'pc_open',
    {
      title: 'Open a page',
      description: 'Distill a page into numbered regions and actions.',
      inputSchema: openInputSchema,
    },
    async (args) =>
      toToolResult(() =>
        runOpen(
          {
            url: args.url,
            ...(args.static !== undefined && { static: args.static }),
          },
          cwd,
        ),
      ),
  );

  server.registerTool(
    'pc_next',
    {
      title: 'Next slice',
      description: 'Return the next slice of a paged render.',
      inputSchema: nextInputSchema,
    },
    async () => toToolResult(() => runNext(cwd)),
  );

  server.registerTool(
    'pc_do',
    {
      title: 'Follow an action',
      description:
        'Follow the action at a numbered handle (click a button, type into an input).',
      inputSchema: doInputSchema,
    },
    async (args) => toToolResult(() => runDo(args.handle, cwd, args.value)),
  );

  server.registerTool(
    'pc_read',
    {
      title: 'Read a region',
      description: 'Read the full text of a numbered region.',
      inputSchema: readInputSchema,
    },
    async (args) => toToolResult(() => runRead(args.handle, cwd)),
  );

  server.registerTool(
    'pc_find',
    {
      title: 'Search the page',
      description: 'Search the currently open page for a query.',
      inputSchema: findInputSchema,
    },
    async (args) => toToolResult(() => runFind(args.query, cwd)),
  );

  server.registerTool(
    'pc_layout',
    {
      title: 'Structural layout',
      description:
        'Structural tree of the current page: regions, roles, boxes.',
      inputSchema: layoutInputSchema,
    },
    async () => toToolResult(() => runLayout(cwd)),
  );

  server.registerTool(
    'pc_tokens',
    {
      title: 'Design tokens',
      description:
        'Extracted colors, type scale, spacing, and radii for the current page.',
      inputSchema: tokensInputSchema,
    },
    async () => toToolResult(() => runTokens(cwd)),
  );

  server.registerTool(
    'pc_scrape',
    {
      title: 'Schema-driven scrape',
      description:
        'Extract fields from the current page per a {field: selector} JSON shape.',
      inputSchema: scrapeInputSchema,
    },
    async (args) => toToolResult(() => runScrape(args.shape, cwd)),
  );

  server.registerTool(
    'pc_data',
    {
      title: 'Extract page data',
      description:
        'Report the data the current page contains: declared structured data, entities, content quality, design system, link graph. Omit domains for an availability summary first.',
      inputSchema: dataInputSchema,
    },
    async (args) =>
      toToolResult(() =>
        runData(
          {
            ...(args.url !== undefined && { url: args.url }),
            domains: args.domains ?? [],
          },
          cwd,
        ),
      ),
  );

  server.registerTool(
    'pc_capture',
    {
      title: 'Full-page capture',
      description:
        'Archive the current page to disk. Defaults to the MCP artifact directory, not the process working directory.',
      inputSchema: captureInputSchema,
    },
    async (args) =>
      toToolResult(async () => {
        const root = resolveArtifactRoot();
        await ensureArtifactRoot(root);
        await sweepArtifactRoot(root, resolveRetentionMs());
        return runCapture(
          {
            ...(args.zip !== undefined && { zip: args.zip }),
            outDir: args.outDir ?? root,
          },
          cwd,
        );
      }),
  );

  return server;
}

/** Connects the server to stdio and resolves once the transport closes
 * (client disconnect or stdin EOF) — the long-running entry point `pc mcp`
 * actually runs. */
export async function startMcpServer(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}
