#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { buildBaseIndex, buildOverlay } from './indexer.js';
import { LiveSession } from './live.js';
import { merge } from './merge.js';
import { query, queryMarkdown, type QueryResult } from './query.js';
import { embedSection, markdownReport } from './report.js';
import { reviewsMarkdown } from './reviews.js';
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
  dyffle comments [--root <dir>]
  dyffle query   [target] [--index <merged.json>] [--json] [--depth N] [--root <dir>]

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
  watch     Run next to a project and keep its dyffles up to date: the
            whole branch, one per commit on the branch, and the uncommitted
            changes. Everything is kept in <root>/.dyffle.
  comments  The review comments made in dyffle watch, as Markdown: for the
            whole branch, per commit and for the uncommitted changes, each
            with its file, line and code. They are stored in
            .dyffle/reviews/<key>.json.
  query     What a symbol or file is connected to and what the branch did to
            it: change, callers, routes, tests and broken references, as short
            Markdown (--json for the full result). The target is a node id, a
            Class.method, Class or function name, or a file path relative to
            --root. No target summarizes the branch. Reads --index, or else
            <root>/.dyffle/live.json, which dyffle watch keeps up to date.

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
  // Before parsing, so its old options don't hide why it fails.
  if (argv[0] === 'post') throw new Error(POST_REMOVED);
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
      index: { type: 'string' },
      json: { type: 'boolean' },
      limit: { type: 'string' },
      report: { type: 'string' },
      map: { type: 'boolean' },
      link: { type: 'string' },
      'embed-in': { type: 'string' },
      port: { type: 'string' },
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
      const { url } = await serve(list.length === 1 ? list[0].index : list, { port: v.port !== undefined ? Number(v.port) : undefined, host: v.host });
      process.stderr.write(`dyffle viewer running at ${url}  (Ctrl+C to stop)\n`);
      break;
    }
    case 'watch': {
      if (!v['base-ref']) throw new UsageError('Pass --base-ref <ref>, the branch the work targets (e.g. origin/main).');
      const session = new LiveSession({ ...project, baseRef: v['base-ref'], depth, log: log ?? (() => {}) });
      await session.start();
      const { url } = await serve(session, { port: v.port !== undefined ? Number(v.port) : undefined, host: v.host });
      session.announce(url);
      process.stderr.write(`dyffle watching ${session.root} at ${url}  (Ctrl+C to stop)\n`);
      const quit = () => {
        session.unannounce();
        process.exit(0);
      };
      process.on('SIGINT', quit);
      process.on('SIGTERM', quit);
      break;
    }
    case 'comments':
      write(reviewsMarkdown(v.root ?? process.cwd()) || 'No review comments yet.\n');
      break;
    case 'query': {
      if (args.length > 1) throw new UsageError('Pass one target, or none for a summary of the branch.');
      if (depth !== undefined && !(Number.isInteger(depth) && depth >= 0)) throw new UsageError('--depth takes a whole number.');
      const result = runQuery(v, args[0], depth, log);
      write(v.json ? json(result) : queryMarkdown(result));
      break;
    }
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

const POST_REMOVED = '"dyffle post" was removed: dyffle watch now keeps a dyffle of every commit on the branch and of the uncommitted changes. Commit your work instead of posting it.';

/** The index to query: --index, or the one dyffle watch keeps up to date. */
function readQueryIndex(v: { root?: string; index?: string }): Index {
  const file = v.index ?? join(resolve(v.root ?? process.cwd()), '.dyffle', 'live.json');
  if (!existsSync(file)) {
    throw new Error(
      v.index
        ? `No index at ${file}.`
        : `No index to query: ${file} does not exist. Pass --index <merged.json>, or run "dyffle watch --base-ref <ref>" in this project to keep it up to date.`,
    );
  }
  const index = (() => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Index;
    } catch {
      return undefined;
    }
  })();
  if (!Array.isArray(index?.nodes)) throw new Error(`${file} is not a dyffle index.`);
  return index;
}

/** Targets are relative to the root, as in node ids. Accept what a shell gives too: ./src/foo.ts, or an absolute path under the root. */
function projectTarget(target: string, root: string): string {
  if (!isAbsolute(target)) return target.replace(/^(\.\/+)+(?=.)/, '');
  const [path, symbol] = target.split(/(?=#)/, 2);
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  // Also through symlinks: on macOS $PWD can be /tmp/x where the process sees /private/tmp/x.
  for (const rel of [relative(resolve(root), path), relative(real(root), real(path))]) {
    if (rel && !isAbsolute(rel) && rel.split(sep)[0] !== '..') return rel.split(sep).join('/') + (symbol ?? '');
  }
  return target;
}

function runQuery(v: { root?: string; index?: string }, rawTarget: string | undefined, depth?: number, log?: (m: string) => void): QueryResult {
  const index = readQueryIndex(v);
  const target = rawTarget === undefined ? undefined : projectTarget(rawTarget, v.root ?? process.cwd());
  if (target !== undefined && !index.checks) log?.(`Note: this is a "${index.kind}" index, it knows nothing about changes or broken references.`);
  try {
    return query(index, target, { depth });
  } catch (e) {
    const skipped = index.pr?.unindexedFiles.find((f) => f.path === target || f.oldPath === target);
    if (!skipped) throw e;
    throw new Error(`${target} changed on this branch (${skipped.status}, +${skipped.additions} −${skipped.deletions}), but dyffle doesn't index that file, so it has no symbols or callers to show.`);
  }
}

main(process.argv.slice(2)).catch((e) => {
  const err = e as Error & { code?: string };
  process.stderr.write(`dyffle: ${err.message}\n`);
  if (e instanceof UsageError || err.code?.startsWith('ERR_PARSE_ARGS')) process.stderr.write('Run "dyffle --help" for usage.\n');
  process.exit(1);
});
