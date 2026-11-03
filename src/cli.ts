#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildBaseIndex, buildOverlay } from './indexer.js';
import { LiveSession, readPostInput, type Post } from './live.js';
import { merge } from './merge.js';
import { embedSection, markdownReport } from './report.js';
import { serve, standaloneHtml } from './serve.js';
import type { Index } from './schema.js';

const HELP = `dyffle: map NestJS and Vue pull requests onto a codebase graph

Usage
  dyffle index   [project options] [-o base.json]
  dyffle overlay (--base-ref <ref> | --diff <file|->) [project options] [-o overlay.json]
  dyffle merge   <base.json> <overlay.json> [--depth N] [-o merged.json]
  dyffle pr      --base <base.json> (--base-ref <ref> | --diff <file|->) [project options] [-o merged.json] [--report report.md]
  dyffle report  <merged.json> [--map] [--link <url>] [--embed-in <body.md>] [--limit N] [-o report.md]
  dyffle html    <merged.json>... [-o pr-map.html]
  dyffle serve   <merged.json>... [--port 4173] [--host 127.0.0.1]
  dyffle watch   --base-ref <ref> [project options] [--port 4173] [--host 127.0.0.1]
  dyffle post    (-m <markdown> | --message-file <file|->) [--title <text>] [--change] [--root <dir>]

Commands
  index     Index the whole codebase (run on main): modules, files, classes,
            methods and functions, each with exact references.
  overlay   Index only the files a PR changed, with the full branch loaded,
            and mark every symbol added, modified or removed.
  merge     Swap an overlay into a base index and run the review checks:
            broken references, signature changes, module dependencies and
            cycles, affected routes and test reach.
  pr        overlay + merge in one step.
  report    Markdown summary of a merged index, for a PR comment or description.
            --map adds a Mermaid module map, --link a link to the interactive
            page. --embed-in <file> prints that file with the report placed
            between dyffle markers (replacing an earlier report), for updating
            a PR description in place.
  html      The interactive page as one self-contained HTML file.
  serve     Open a merged index in the browser: folder map, review checks,
            changed symbols with their diffs, callers and routes.
            html and serve take several merged indexes too, e.g. one per
            commit, and the page switches between them. Each is listed
            under its file name.
  watch     Run next to a project: serve a dyffle of the whole branch that
            follows every saved file, and a feed of posts. A post is a
            Markdown message, optionally with a dyffle of what changed since
            the previous post. Everything is kept in <root>/.dyffle.
  post      Post to the feed of a running dyffle watch and wait until it is
            in. --change attaches what changed since the previous post.
            The same as writing {"title", "message", "change"} to
            .dyffle/inbox/<name>.json.

Post options
  -m, --message <md>      The post, in Markdown
  --message-file <file|-> Read the post from a file, or - for stdin
  --title <text>          A short title (default: the first line)
  --change                Attach a dyffle of the change since the previous post
  --author <name>         Default: claude
  --queue                 Don't wait for dyffle watch to take the post in

Project options
  --root <dir>        Directory node ids are relative to (default: cwd)
  --tsconfig <file>   tsconfig for compiler options and path aliases
                      (default: <root>/tsconfig.json)
  --include <glob>    Files to index, repeatable (default: **/*.ts and **/*.vue)
  --exclude <glob>    Extra files to skip, repeatable

Diff options
  --base-ref <ref>    Branch the PR targets, e.g. origin/main. The diff is taken
                      from its merge base to the working tree.
  --diff <file|->     Use this unified diff instead (git diff, or a PR's .diff).
                      Paths must be relative to --root.

Output
  -o, --out <file>    Write to a file instead of stdout
  --pretty            Indent JSON output
  -q, --quiet         No progress messages on stderr
`;

async function main(argv: string[]): Promise<void> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      tsconfig: { type: 'string' },
      include: { type: 'string', multiple: true },
      exclude: { type: 'string', multiple: true },
      'base-ref': { type: 'string' },
      diff: { type: 'string' },
      base: { type: 'string' },
      depth: { type: 'string' },
      limit: { type: 'string' },
      report: { type: 'string' },
      map: { type: 'boolean' },
      link: { type: 'string' },
      'embed-in': { type: 'string' },
      port: { type: 'string' },
      message: { type: 'string', short: 'm' },
      'message-file': { type: 'string' },
      title: { type: 'string' },
      change: { type: 'boolean' },
      author: { type: 'string' },
      queue: { type: 'boolean' },
      host: { type: 'string' },
      out: { type: 'string', short: 'o' },
      pretty: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const [cmd, ...args] = positionals;
  if (v.version) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    return;
  }
  if (v.help || !cmd) {
    process.stdout.write(HELP);
    return;
  }

  const log = v.quiet ? undefined : (m: string) => process.stderr.write(m + '\n');
  const project = { root: v.root, tsconfig: v.tsconfig, include: v.include, exclude: v.exclude, log };
  const readIndex = (p: string | undefined, what: string): Index => {
    if (!p) throw new UsageError(`Missing ${what}.`);
    return JSON.parse(readFileSync(p, 'utf8')) as Index;
  };
  /** The merged indexes given as arguments, each labeled with its file name. */
  const readMerged = (what: string) => {
    if (!args.length) throw new UsageError('Missing merged index path.');
    return args.map((p) => {
      const index = readIndex(p, 'merged index path');
      if (!index.checks) throw new UsageError(`${what} needs merged indexes (output of dyffle merge or dyffle pr); ${p} is not one.`);
      return { label: basename(p).replace(/\.json$/i, ''), index };
    });
  };
  const readDiff = () => (v.diff === undefined ? undefined : readFileSync(v.diff === '-' ? 0 : v.diff, 'utf8'));
  const write = (text: string, file = v.out) => {
    if (file) {
      writeFileSync(file, text);
      log?.(`Wrote ${file}`);
    } else process.stdout.write(text);
  };
  const json = (x: unknown) => JSON.stringify(x, null, v.pretty ? 2 : undefined) + '\n';
  const depth = v.depth ? Number(v.depth) : undefined;
  const needDiff = () => {
    if (!v['base-ref'] && v.diff === undefined) throw new UsageError('Pass --base-ref <ref> or --diff <file>.');
  };

  switch (cmd) {
    case 'index':
      write(json(buildBaseIndex(project)));
      break;
    case 'overlay':
      needDiff();
      write(json(buildOverlay({ ...project, baseRef: v['base-ref'], diff: readDiff() })));
      break;
    case 'merge':
      write(json(merge(readIndex(args[0], 'base index path'), readIndex(args[1], 'overlay path'), { depth })));
      break;
    case 'pr': {
      needDiff();
      const base = readIndex(v.base, '--base <base.json>');
      const merged = merge(base, buildOverlay({ ...project, baseRef: v['base-ref'], diff: readDiff() }), { depth });
      write(json(merged));
      if (v.report) write(markdownReport(merged), v.report);
      break;
    }
    case 'serve': {
      const list = readMerged('serve').map((x) => ({ label: x.label, index: JSON.stringify(x.index) }));
      const { url } = await serve(list.length === 1 ? list[0].index : list, { port: v.port ? Number(v.port) : undefined, host: v.host });
      process.stderr.write(`dyffle viewer running at ${url}  (Ctrl+C to stop)\n`);
      break;
    }
    case 'watch': {
      if (!v['base-ref']) throw new UsageError('Pass --base-ref <ref>, the branch the work targets (e.g. origin/main).');
      const session = new LiveSession({ ...project, baseRef: v['base-ref'], depth, log: log ?? (() => {}) });
      await session.start();
      const { url } = await serve(session, { port: v.port ? Number(v.port) : undefined, host: v.host });
      session.announce(url);
      process.stderr.write(`dyffle watching ${session.root} at ${url}  (Ctrl+C to stop)\n`);
      const quit = () => {
        try {
          unlinkSync(join(session.dir, 'server.json'));
        } catch {
          /* already gone */
        }
        process.exit(0);
      };
      process.on('SIGINT', quit);
      process.on('SIGTERM', quit);
      break;
    }
    case 'post':
      await post(v, log);
      break;
    case 'report': {
      const md = markdownReport(readIndex(args[0], 'merged index path'), {
        limit: v.limit ? Number(v.limit) : undefined,
        map: v.map,
        link: v.link,
      });
      write(v['embed-in'] !== undefined ? embedSection(readFileSync(v['embed-in'], 'utf8'), md) : md);
      break;
    }
    case 'html': {
      const list = readMerged('html');
      write(standaloneHtml(list.length === 1 ? list[0].index : list));
      break;
    }
    default:
      throw new UsageError(`Unknown command "${cmd}".`);
  }
}

class UsageError extends Error {}

interface PostArgs {
  root?: string;
  message?: string;
  'message-file'?: string;
  title?: string;
  change?: boolean;
  author?: string;
  queue?: boolean;
}

/** Write a post to the inbox of dyffle watch and wait until it is a post (or rejected). */
async function post(v: PostArgs, log?: (m: string) => void): Promise<void> {
  const message = v.message ?? (v['message-file'] !== undefined ? readFileSync(v['message-file'] === '-' ? 0 : v['message-file'], 'utf8') : undefined);
  if (message === undefined) throw new UsageError('Pass -m <markdown> or --message-file <file|->.');
  const input = readPostInput({ message, title: v.title, author: v.author, change: v.change });
  const dir = join(resolve(v.root ?? process.cwd()), '.dyffle');
  const server = (() => {
    try {
      const s = JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8')) as { pid: number; url: string };
      process.kill(s.pid, 0);
      return s;
    } catch {
      return undefined;
    }
  })();
  if (!server && !v.queue) throw new Error(`dyffle watch is not running in ${resolve(dir, '..')}. Start it with "dyffle watch --base-ref origin/main", or pass --queue.`);
  const name = `${Date.now()}-${process.pid}.json`;
  const file = join(dir, 'inbox', name);
  if (!existsSync(join(dir, 'inbox'))) throw new Error(`No ${join(dir, 'inbox')}; run "dyffle watch" in this project first.`);
  writeFileSync(file + '.tmp', JSON.stringify(input, null, 2) + '\n');
  renameSync(file + '.tmp', file);
  if (v.queue) {
    log?.(`Queued ${file}`);
    return;
  }
  const error = file.replace(/\.json$/, '.error');
  for (const until = Date.now() + 10 * 60_000; Date.now() < until; await new Promise((r) => setTimeout(r, 200))) {
    if (existsSync(error)) {
      const why = readFileSync(error, 'utf8').trim();
      unlinkSync(error);
      throw new Error(`The post was rejected: ${why}`);
    }
    if (existsSync(file)) continue;
    const posts = join(dir, 'posts');
    for (const f of readdirSync(posts).filter((x) => /^\d+\.json$/.test(x))) {
      const p = JSON.parse(readFileSync(join(posts, f), 'utf8')) as Post;
      if (p.source !== name) continue;
      const what = p.stats ? `, ${p.stats.files} files +${p.stats.additions} −${p.stats.deletions}` : p.note ? ` (${p.note})` : '';
      process.stdout.write(`Posted #${p.id}${what}: ${server!.url}\n`);
      return;
    }
  }
  throw new Error(`dyffle watch did not take ${file} in within 10 minutes.`);
}

main(process.argv.slice(2)).catch((e) => {
  const err = e as Error & { code?: string };
  process.stderr.write(`dyffle: ${err.message}\n`);
  if (e instanceof UsageError || err.code?.startsWith('ERR_PARSE_ARGS')) process.stderr.write('Run "dyffle --help" for usage.\n');
  process.exit(1);
});
