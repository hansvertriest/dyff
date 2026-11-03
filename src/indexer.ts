import { readFileSync } from 'node:fs';
import { Analyzer, type FileAnalysis, type ProjectOptions } from './analyzer.js';
import { deletedText, filterHunks, hunksWithin, parseUnifiedDiff, reverseApply, sliceHunks, type DiffFile } from './diff.js';
import { finalize, moduleAssigner } from './finalize.js';
import { diffAgainst, headCommit, mergeBase, showFile } from './git.js';
import { SCHEMA_VERSION, type FileInfo, type Index, type IndexKind, type PrInfo, type SymbolNode } from './schema.js';
import { collectFile, compactSignature } from './symbols.js';
import { isVueFile, parseSource, vueBlockLines } from './vue.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };

export type Logger = (msg: string) => void;

function emptyIndex(kind: IndexKind, root: string): Index {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind,
    tool: { name: pkg.name, version: pkg.version },
    generatedAt: new Date().toISOString(),
    root,
    modules: [],
    files: [],
    nodes: [],
  };
}

function addAnalysis(index: Index, r: FileAnalysis): void {
  index.files.push({ ...r.info, module: '' });
  for (const n of r.nodes) index.nodes.push({ ...n, module: '', references: [] });
  for (const m of r.modules) index.modules.push({ ...m, id: '' });
  if (r.globalPrefix !== undefined && index.globalPrefix === undefined) index.globalPrefix = r.globalPrefix;
}

/** Index a whole codebase: every module, file, class and function with exact references. */
export function buildBaseIndex(opts: ProjectOptions & { log?: Logger } = {}): Index {
  const a = new Analyzer(opts);
  const index = emptyIndex('base', a.root);
  const commit = headCommit(a.root);
  if (commit) index.commit = commit;
  const paths = a.sourcePaths();
  opts.log?.(`Indexing ${paths.length} files`);
  paths.forEach((p, i) => {
    addAnalysis(index, a.analyzeFile(p));
    if (opts.log && (i + 1) % 200 === 0) opts.log(`  ${i + 1}/${paths.length}`);
  });
  return finalize(index);
}

export interface OverlayOptions extends ProjectOptions {
  /** Branch or commit the PR targets (e.g. origin/main). The diff is taken against its merge base. */
  baseRef?: string;
  /** Unified diff text. When omitted, it is computed with git from baseRef. */
  diff?: string;
  /** Commit the diff starts from, when it is not the merge base of baseRef (e.g. an earlier snapshot). */
  baseCommit?: string;
  /** Commit the diff ends at, when the working tree is not HEAD (e.g. a snapshot of it). */
  headCommit?: string;
  /** A program already loaded for this working tree, to reuse instead of loading it again. */
  analyzer?: Analyzer;
  log?: Logger;
}

const TS_FILE = /\.[cm]?tsx?$/;
const isIndexable = (p: string) => (TS_FILE.test(p) || isVueFile(p)) && !p.endsWith('.d.ts') && !p.includes('node_modules/');

/**
 * Index only the files a PR changed, with the whole branch loaded so references
 * resolve exactly. Each changed file is re-indexed in full and compared with its
 * base-side version to mark nodes added, modified or removed.
 */
export function buildOverlay(opts: OverlayOptions): Index {
  const a = opts.analyzer ?? new Analyzer(opts);
  const index = emptyIndex('overlay', a.root);
  let baseCommit = opts.baseCommit;
  let diffText = opts.diff;
  if (!baseCommit && opts.baseRef) baseCommit = mergeBase(a.root, opts.baseRef);
  if (diffText === undefined) {
    if (!baseCommit) throw new Error('Pass a diff or a base ref (e.g. --base-ref origin/main).');
    diffText = diffAgainst(a.root, baseCommit);
  }
  const head = opts.headCommit ?? headCommit(a.root);
  if (head) index.commit = head;

  const diffFiles = parseUnifiedDiff(diffText);
  const projectPaths = new Set(a.sourcePaths());
  const pr: PrInfo = {
    ...(opts.baseRef ? { baseRef: opts.baseRef } : {}),
    ...(baseCommit ? { baseCommit } : {}),
    ...(head ? { headCommit: head } : {}),
    changedFiles: diffFiles.map((f) => f.path),
    deletedFiles: diffFiles.filter((f) => f.status === 'removed').map((f) => f.path),
    renamedFiles: diffFiles.filter((f) => f.status === 'renamed').map((f) => ({ from: f.oldPath!, to: f.path })),
    deletedSymbols: [],
    renamedSymbols: {},
    unindexedFiles: [],
  };
  opts.log?.(`Diff touches ${diffFiles.length} files`);

  const oldTextOf = (df: DiffFile): string | undefined => {
    const oldPath = df.oldPath ?? df.path;
    if (df.status === 'added') return undefined;
    if (df.status === 'removed' && df.hunks.length) return deletedText(df.hunks);
    if (df.status !== 'removed') {
      const cur = a.text(df.path)?.replace(/\r\n/g, '\n');
      if (cur !== undefined) {
        const text = reverseApply(cur, df.hunks);
        if (text !== null) return text;
      }
    }
    const fromGit = baseCommit ? showFile(a.root, baseCommit, oldPath) : undefined;
    if (fromGit === undefined)
      opts.log?.(`warning: could not reconstruct the base version of ${oldPath}; the diff does not match the working tree`);
    return fromGit?.replace(/\r\n/g, '\n');
  };

  for (const df of diffFiles) {
    const oldPath = df.oldPath ?? df.path;
    const indexedNew = df.status !== 'removed' && projectPaths.has(df.path);
    const indexedOld = df.status === 'removed' && isIndexable(oldPath);
    if (!indexedNew && !indexedOld) {
      pr.unindexedFiles.push({
        path: df.path,
        ...(df.status === 'renamed' ? { oldPath } : {}),
        status: df.status,
        additions: df.additions,
        deletions: df.deletions,
        hunks: df.hunks,
      });
      continue;
    }

    // Base side: parse the old text without a type checker; only ranges, hashes and signatures are needed.
    const oldNodes = new Map<string, Omit<SymbolNode, 'module' | 'uses' | 'references'>>();
    const oldText = oldTextOf(df);
    if (oldText !== undefined) {
      const sf = parseSource(oldPath, oldText);
      for (const { decl: _decl, ...n } of collectFile(sf, oldPath).nodes) {
        const id = oldPath === df.path ? n.id : df.path + n.id.slice(oldPath.length);
        oldNodes.set(id, n);
        if (id !== n.id) pr.renamedSymbols[n.id] = id;
      }
    }
    const fileChange: NonNullable<FileInfo['change']> = {
      status: df.status,
      ...(df.status === 'renamed' ? { oldPath } : {}),
      additions: df.additions,
      deletions: df.deletions,
      hunks: df.hunks,
    };
    // A file's own lines are the ones no symbol holds (imports and other top-level code), and in a
    // .vue file only those inside <script>: the template and styles get sections of their own.
    const vueBlocks = (text: string | undefined) => (text !== undefined && isVueFile(df.path) ? vueBlockLines(text) : undefined);
    const ownLines = (symbols: [number, number][], blocks: ReturnType<typeof vueBlocks>) => {
      const scripts = blocks?.filter((b) => b.tag === 'script').map((b) => b.range);
      const inAny = (rs: [number, number][], x: number) => rs.some((r) => x >= r[0] && x <= r[1]);
      return (x?: number) => x != null && !inAny(symbols, x) && (!scripts || inAny(scripts, x));
    };
    const oldBlocks = vueBlocks(oldText);
    const oldOwn = ownLines([...oldNodes.values()].filter((n) => n.kind !== 'file').map((n) => n.range), oldBlocks);

    if (df.status === 'removed') {
      index.files.push({ path: df.path, module: '', test: false, hash: '', imports: [], change: fileChange });
    } else {
      const r = a.analyzeFile(df.path);
      addAnalysis(index, r);
      (index.files[index.files.length - 1] as FileInfo).change = fileChange;
      const added = index.nodes.slice(index.nodes.length - r.nodes.length);
      const newBlocks = vueBlocks(a.text(df.path)?.replace(/\r\n/g, '\n'));
      const newOwn = ownLines(added.filter((n) => n.kind !== 'file').map((n) => n.range), newBlocks);
      const hunksOf = (n: SymbolNode, oldRange?: [number, number]) =>
        n.kind === 'file' ? filterHunks(df.hunks, (l) => (l.t === '-' ? oldOwn(l.o) : newOwn(l.n))) : sliceHunks(df.hunks, n.range, oldRange);
      for (const tag of ['template', 'style'] as const) {
        const ranges = (bs: ReturnType<typeof vueBlocks>) => (bs ?? []).filter((b) => b.tag === tag).map((b) => b.range);
        const hunks = hunksWithin(df.hunks, ranges(newBlocks), ranges(oldBlocks));
        if (hunks.length) (fileChange.sections ??= []).push({ name: tag, hunks });
      }
      for (const n of added) {
        const old = oldNodes.get(n.id);
        oldNodes.delete(n.id);
        if (!old) {
          n.change = { status: 'added', hunks: hunksOf(n) };
          continue;
        }
        if (old.hash === n.hash) continue;
        const renamedFrom = old.id !== n.id ? { previousId: old.id } : {};
        const sigChanged = compactSignature(old.signature) !== compactSignature(n.signature);
        n.change = {
          status: 'modified',
          hunks: hunksOf(n, old.range),
          previousRange: old.range,
          ...renamedFrom,
          ...(sigChanged ? { signatureChanged: true, previousSignature: old.signature ?? '' } : {}),
        };
      }
      for (const m of index.modules.slice(index.modules.length - r.modules.length)) {
        const status = added.find((n) => n.id === m.classId)?.change?.status;
        if (status) m.change = { status };
      }
    }

    for (const [, old] of oldNodes) {
      pr.deletedSymbols.push({
        ...old,
        id: old.id,
        module: '',
        uses: [],
        references: [],
        change: { status: 'removed', hunks: sliceHunks(df.hunks, undefined, old.range), previousRange: old.range },
      });
    }
  }

  index.pr = pr;
  const allPaths = [...projectPaths, ...pr.deletedFiles];
  finalize(index, allPaths);
  const { moduleOf } = moduleAssigner(allPaths);
  for (const s of pr.deletedSymbols) s.module = moduleOf(s.file);
  return index;
}
