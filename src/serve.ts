import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';

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

/** Indexes that change while the server runs (dyffle watch), with a review of each. */
export interface LiveSource {
  labels(): string[];
  /** One merged index as JSON, by its position in labels(). */
  index(i: number): string | undefined;
  /** What each index is, as JSON: `{ views: [{ key, kind, index, title, stats, comments, ... }] }`. */
  views(): string;
  /** A file's text as JSON, as the dyffle with this key (`live`, `uncommitted`, `commit-<sha>`) shows it; undefined when it isn't in that dyffle. */
  source(key: string, path: string): string | undefined;
  /** The review of the dyffle with this key as JSON, or undefined for an unknown key. */
  review(key: string): string | undefined;
  /** Store a review sent by a viewer; `client` identifies the page, so it can skip its own change. */
  saveReview(key: string, json: string, client?: string): void;
  /** Call `send` on every change; returns a function that stops it. */
  subscribe(send: (event: string, data: unknown) => void): () => void;
}

export interface ServeOptions {
  port?: number;
  host?: string;
}

/** A request body as text, up to 1 MB. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1 << 20) {
        reject(new Error('Request body over 1 MB'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const isLive = (x: unknown): x is LiveSource => typeof x === 'object' && x !== null && 'subscribe' in x;

/**
 * Serve the viewer page and a merged index on http://host:port/. With several
 * indexes, /indexes.json lists their labels and /index.json?i=N serves one.
 * A live source also serves /views.json, /source.json, /review.json and /events, a stream of changes.
 */
export function serve(indexJson: string | LabeledIndex<string>[] | LiveSource, opts: ServeOptions = {}): Promise<{ server: Server; url: string }> {
  const host = opts.host ?? '127.0.0.1';
  const live = isLive(indexJson) ? indexJson : undefined;
  const fixed = Array.isArray(indexJson) ? indexJson : [{ label: '', index: indexJson as string }];
  const indexAt = (i: number) => (live ? live.index(i) : fixed[i]?.index);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const index = url.pathname === '/index.json' ? indexAt(Number(url.searchParams.get('i') ?? 0)) : undefined;
    const key = url.searchParams.get('key') ?? '';
    const found = !live || req.method !== 'GET' ? undefined
      : url.pathname === '/source.json' ? live.source(key, url.searchParams.get('path') ?? '')
      : url.pathname === '/review.json' ? live.review(key)
      : undefined;
    const json = (body: string) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    };
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      // Read on every request, so edits to the viewer show on reload.
      res.end(readFileSync(VIEWER));
    } else if (url.pathname === '/indexes.json') {
      json(JSON.stringify(live ? live.labels() : fixed.map((x) => x.label)));
    } else if (index !== undefined) {
      json(index);
    } else if (live && url.pathname === '/review.json' && req.method === 'PUT') {
      readBody(req)
        .then((body) => {
          live.saveReview(key, body, url.searchParams.get('client') ?? undefined);
          res.writeHead(204).end();
        })
        .catch((e: Error) => {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end(e.message);
        });
    } else if (found !== undefined) {
      json(found);
    } else if (live && url.pathname === '/views.json') {
      json(live.views());
    } else if (live && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': dyffle\n\n');
      const stop = live.subscribe((event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      req.on('close', stop);
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
