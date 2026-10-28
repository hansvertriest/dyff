import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';

const VIEWER = new URL('../viewer/index.html', import.meta.url);

export interface ServeOptions {
  port?: number;
  host?: string;
}

/** Serve the viewer page and a merged index on http://host:port/. */
export function serve(indexJson: string, opts: ServeOptions = {}): Promise<{ server: Server; url: string }> {
  const html = readFileSync(VIEWER);
  const host = opts.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } else if (path === '/index.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(indexJson);
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4173, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({ server, url: `http://${host.includes(':') ? `[${host}]` : host}:${port}/` });
    });
  });
}
