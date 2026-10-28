import { readFileSync } from 'node:fs';
import { ts } from 'ts-morph';
import { Analyzer, type FileAnalysis, type ProjectOptions } from './analyzer.js';
import { deletedText, parseUnifiedDiff, reverseApply, sliceHunks, type DiffFile } from './diff.js';
import { finalize, moduleAssigner } from './finalize.js';
import { diffAgainst, headCommit, mergeBase, showFile } from './git.js';
import { SCHEMA_VERSION, type FileInfo, type Index, type IndexKind, type PrInfo, type SymbolNode } from './schema.js';
import { collectFile, compactSignature } from './symbols.js';

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
  log?: Logger;
}

const TS_FILE = /\.[cm]?tsx?$/;
const isIndexable = (p: string) => TS_FILE.test(p) && !p.endsWith('.d.ts') && !p.includes('node_modules/');

/**
 * Index only the files a PR changed, with the whole branch loaded so references
 * resolve exactly. Each changed file is re-indexed in full and compared with its
 * base-side version to mark nodes added, modified or removed.
 */
export function buildOverlay(opts: OverlayOptions): Index {
  const a = new Analyzer(opts);
  const index = emptyIndex('overlay', a.root);
  let baseCommit: string | undefined;
  let diffText = opts.diff;
  if (opts.baseRef) baseCommit = mergeBase(a.root, opts.baseRef);
  if (diffText === undefined) {
    if (!baseCommit) throw new Error('Pass a diff or a base ref (e.g. --base-ref origin/main).');
    diffText = diffAgainst(a.root, baseCommit);
  }
  const head = headCommit(a.root);
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
      const cur = a.sourceFile(df.path)?.getFullText().replace(/\r\n/g, '\n');
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
      pr.unindexedFiles.push({ path: df.path, status: df.status, additions: df.additions, deletions: df.deletions });
      continue;
    }

    // Base side: parse the old text without a type checker; only ranges, hashes and signatures are needed.
    const oldNodes = new Map<string, Omit<SymbolNode, 'module' | 'uses' | 'references'>>();
    const oldText = oldTextOf(df);
    if (oldText !== undefined) {
      const sf = ts.createSourceFile(oldPath, oldText, ts.ScriptTarget.Latest, true);
      for (const { decl: _decl, ...n } of collectFile(sf, oldPath).nodes) {
        const id = oldPath === df.path ? n.id : df.path + n.id.slice(oldPath.length);
        oldNodes.set(id, n);
        if (id !== n.id) pr.renamedSymbols[n.id] = id;
      }
    }
    const fileChange = {
      status: df.status,
      ...(df.status === 'renamed' ? { oldPath } : {}),
      additions: df.additions,
      deletions: df.deletions,
      hunks: df.hunks,
    };

    if (df.status === 'removed') {
      index.files.push({ path: df.path, module: '', test: false, hash: '', imports: [], change: fileChange });
    } else {
      const r = a.analyzeFile(df.path);
      addAnalysis(index, r);
      (index.files[index.files.length - 1] as FileInfo).change = fileChange;
      const added = index.nodes.slice(index.nodes.length - r.nodes.length);
      for (const n of added) {
        const old = oldNodes.get(n.id);
        oldNodes.delete(n.id);
        if (!old) {
          n.change = { status: 'added', hunks: sliceHunks(df.hunks, n.range, undefined) };
          continue;
        }
        if (old.hash === n.hash) continue;
        const renamedFrom = old.id !== n.id ? { previousId: old.id } : {};
        const sigChanged = compactSignature(old.signature) !== compactSignature(n.signature);
        n.change = {
          status: 'modified',
          hunks: sliceHunks(df.hunks, n.range, old.range),
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
