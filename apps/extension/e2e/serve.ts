import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** Serves e2e/fixtures over http so captures exercise real network loading. */
export function startFixtureServer(port = 4321): Promise<Server> {
  const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

  const server = createServer((request, response) => {
    const requested = (request.url ?? '/').split('?')[0] ?? '/';
    const path = normalize(join(root, requested));
    if (!path.startsWith(root) || !existsSync(path)) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      // Cross-origin reads must go through the extension's proxy, exactly as
      // they would on a real site.
      'cache-control': 'no-store',
    });
    response.end(readFileSync(path));
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}
