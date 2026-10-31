import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';

const VIEWER = new URL('../viewer/index.html', import.meta.url);

/** One of several merged indexes shown in one viewer, e.g. one per commit, with the name the viewer lists it under. */
export interface LabeledIndex<T = unknown> {
  label: string;
  index: T;
}

const scriptJson = (x: unknown) => JSON.stringify(x).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** The viewer as one self-contained HTML file with the index, or several to switch between, embedded. */
export function standaloneHtml(index: unknown | LabeledIndex[]): string {
  const data = Array.isArray(index) ? `window.DYFFLE_LIST = ${scriptJson(index)};` : `window.DYFFLE_DATA = ${scriptJson(index)};`;
  const html = readFileSync(VIEWER, 'utf8');
  const at = html.indexOf('<script>');
  return html.slice(0, at) + `<script>${data}</script>\n` + html.slice(at);
}

export interface ServeOptions {
  port?: number;
  host?: string;
}

/**
 * Serve the viewer page and a merged index on http://host:port/. With several
 * indexes, /indexes.json lists their labels and /index.json?i=N serves one.
 */
export function serve(indexJson: string | LabeledIndex<string>[], opts: ServeOptions = {}): Promise<{ server: Server; url: string }> {
  const host = opts.host ?? '127.0.0.1';
  const list = Array.isArray(indexJson) ? indexJson : [{ label: '', index: indexJson }];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (body: string) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    };
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      // Read on every request, so edits to the viewer show on reload.
      res.end(readFileSync(VIEWER));
    } else if (url.pathname === '/indexes.json') {
      json(JSON.stringify(list.map((x) => x.label)));
    } else if (url.pathname === '/index.json' && list[Number(url.searchParams.get('i') ?? 0)]) {
      json(list[Number(url.searchParams.get('i') ?? 0)].index);
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
