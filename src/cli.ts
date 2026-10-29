#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { buildBaseIndex, buildOverlay } from './indexer.js';
import { merge } from './merge.js';
import { embedSection, markdownReport } from './report.js';
import { serve, standaloneHtml } from './serve.js';
import type { Index } from './schema.js';

const HELP = `dyff: map NestJS and Vue pull requests onto a codebase graph

Usage
  dyff index   [project options] [-o base.json]
  dyff overlay (--base-ref <ref> | --diff <file|->) [project options] [-o overlay.json]
  dyff merge   <base.json> <overlay.json> [--depth N] [-o merged.json]
  dyff pr      --base <base.json> (--base-ref <ref> | --diff <file|->) [project options] [-o merged.json] [--report report.md]
  dyff report  <merged.json> [--map] [--link <url>] [--embed-in <body.md>] [--limit N] [-o report.md]
  dyff html    <merged.json> [-o pr-map.html]
  dyff serve   <merged.json> [--port 4173] [--host 127.0.0.1]

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
            between dyff markers (replacing an earlier report), for updating
            a PR description in place.
  html      The interactive page as one self-contained HTML file.
  serve     Open a merged index in the browser: module map, review checks,
            changed symbols with their diffs, callers and routes.

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
      const index = readIndex(args[0], 'merged index path');
      if (!index.checks) throw new UsageError('serve needs a merged index (output of dyff merge or dyff pr).');
      const { url } = await serve(JSON.stringify(index), { port: v.port ? Number(v.port) : undefined, host: v.host });
      process.stderr.write(`dyff viewer running at ${url}  (Ctrl+C to stop)\n`);
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
      const index = readIndex(args[0], 'merged index path');
      if (!index.checks) throw new UsageError('html needs a merged index (output of dyff merge or dyff pr).');
      write(standaloneHtml(index));
      break;
    }
    default:
      throw new UsageError(`Unknown command "${cmd}".`);
  }
}

class UsageError extends Error {}

main(process.argv.slice(2)).catch((e) => {
  const err = e as Error & { code?: string };
  process.stderr.write(`dyff: ${err.message}\n`);
  if (e instanceof UsageError || err.code?.startsWith('ERR_PARSE_ARGS')) process.stderr.write('Run "dyff --help" for usage.\n');
  process.exit(1);
});
