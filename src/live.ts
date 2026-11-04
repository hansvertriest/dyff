import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { Analyzer, type ProjectOptions } from './analyzer.js';
import { buildBaseIndex, buildOverlay, type Logger, type OverlayOptions } from './indexer.js';
import { branchCommits, diffBetween, extractCommit, git, headCommit, mergeBase, showFile, worktreeTree, type BranchCommit } from './git.js';
import { merge, rebase } from './merge.js';
import { isReviewKey, readReviewInput, ReviewStore, type Review } from './reviews.js';
import type { Index } from './schema.js';
import type { LiveSource } from './serve.js';

export interface WatchOptions extends ProjectOptions {
  /** Branch the work targets, e.g. origin/main. The branch dyffle is taken from its merge base. */
  baseRef: string;
  depth?: number;
  /** How often to look for changed files and new commits, in ms. Default 1000. */
  interval?: number;
  log?: Logger;
}

export type LiveViewKind = 'branch' | 'commit' | 'uncommitted';

/** One dyffle `dyffle watch` keeps, as the viewer lists it (GET /views.json). */
export interface LiveView {
  /** `live`, `commit-<sha>` or `uncommitted`: also the key of its review. */
  key: string;
  kind: LiveViewKind;
  /** Position in the picker: the `i` of /index.json?i=. */
  index: number;
  title: string;
  generatedAt?: string;
  stats?: DyffleStats;
  /** Review comments on it. */
  comments: number;
  /** For a commit. */
  sha?: string;
  author?: string;
  date?: string;
}

export interface DyffleStats {
  files: number;
  additions: number;
  deletions: number;
  symbols: number;
}

/** A dyffle built from a tree: its JSON, and the files it shows, the only ones served as source. */
interface Built {
  json: string;
  generatedAt: string;
  stats: DyffleStats;
  files: Set<string>;
}

/** A commit on the branch with its dyffle against its parent, cached as .dyffle/commits/<sha>.json. */
interface CommitView extends BranchCommit {
  stats: DyffleStats;
  files?: Set<string>;
}

const BRANCH_LABEL = 'Branch (live)';
const UNCOMMITTED_LABEL = 'Uncommitted';
const UNCOMMITTED_TITLE = 'Uncommitted changes';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * dyffle running next to a project. It keeps three kinds of dyffle up to date: the whole branch
 * against its merge base with baseRef, one per commit on the branch against its parent, and the
 * uncommitted changes against HEAD. The branch and uncommitted dyffles follow every saved file;
 * a commit's is built once and cached. Reviews of each are kept too. Everything is in <root>/.dyffle.
 */
export class LiveSession implements LiveSource {
  readonly root: string;
  readonly dir: string;
  private readonly project: ProjectOptions;
  private readonly reviews: ReviewStore;
  private base?: { commit: string; index: Index };
  /** HEAD the commits and the uncommitted dyffle were built for, and the codebase index at it. */
  private head?: { commit: string; index: Index };
  private commits: CommitView[] = [];
  private live?: { tree: string; branch: Built; uncommitted: Built };
  private listeners = new Set<(event: string, data: unknown) => void>();
  private stopped = false;
  private loop?: Promise<void>;

  constructor(private readonly opts: WatchOptions) {
    this.root = resolve(opts.root ?? process.cwd());
    this.dir = join(this.root, '.dyffle');
    this.project = { root: this.root, tsconfig: opts.tsconfig, include: opts.include, exclude: opts.exclude };
    this.reviews = new ReviewStore(join(this.dir, 'reviews'));
  }

  private get log(): Logger {
    return this.opts.log ?? (() => {});
  }

  /** Build the base, the commits and the live dyffles, then keep watching until stop(). */
  async start(): Promise<void> {
    for (const d of ['commits', 'reviews']) mkdirSync(join(this.dir, d), { recursive: true });
    // Keeps .dyffle out of git status and out of the working tree's dyffles.
    writeFileSync(join(this.dir, '.gitignore'), '*\n');
    this.update();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }

  /** Record where the viewer runs. */
  announce(url: string): void {
    writeFileSync(join(this.dir, 'server.json'), JSON.stringify({ pid: process.pid, url, startedAt: new Date().toISOString() }, null, 2) + '\n');
  }

  /**
   * Undo announce(): remove this root's server.json if it holds this process's pid. A file of another
   * process stays. Never throws, so it is safe on the way out: a missing or malformed file has nothing of ours to remove.
   */
  unannounce(): void {
    const file = join(this.dir, 'server.json');
    try {
      if ((JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown } | null)?.pid === process.pid) unlinkSync(file);
    } catch {
      /* missing or malformed */
    }
  }

  /* ---------- LiveSource ---------- */

  labels(): string[] {
    return [BRANCH_LABEL, ...this.commits.map((c) => `${c.sha.slice(0, 7)} ${c.subject}`), UNCOMMITTED_LABEL];
  }

  index(i: number): string | undefined {
    if (i === 0) return this.live?.branch.json;
    if (i === this.commits.length + 1) return this.live?.uncommitted.json;
    const c = this.commits[i - 1];
    return c ? readFileSync(this.commitFile(c.sha), 'utf8') : undefined;
  }

  views(): string {
    const views: Omit<LiveView, 'comments'>[] = [
      { key: 'live', kind: 'branch', index: 0, title: 'Whole branch', ...this.builtView(this.live?.branch) },
      ...this.commits.map((c, i) => ({ key: commitKey(c.sha), kind: 'commit' as const, index: i + 1, title: c.subject, stats: c.stats, sha: c.sha, author: c.author, date: c.date })),
      { key: 'uncommitted', kind: 'uncommitted', index: this.commits.length + 1, title: UNCOMMITTED_TITLE, ...this.builtView(this.live?.uncommitted) },
    ];
    return JSON.stringify({ views: views.map((v): LiveView => ({ ...v, comments: this.reviews.comments(v.key) })) });
  }

  /**
   * The text of a file as a dyffle shows it: from the tree that dyffle was built from, so it matches
   * the map even after the working tree moved on. Only files in that dyffle are served, not removed ones.
   */
  source(key: string, path: string): string | undefined {
    let object: string | undefined, files: Set<string> | undefined;
    if (key === 'live') [object, files] = [this.live?.tree, this.live?.branch.files];
    else if (key === 'uncommitted') [object, files] = [this.live?.tree, this.live?.uncommitted.files];
    else {
      const c = this.commitOf(key);
      if (!c) return undefined;
      object = c.sha;
      files = c.files ??= sourceFiles(JSON.parse(readFileSync(this.commitFile(c.sha), 'utf8')) as Index);
    }
    if (!object || !files?.has(path)) return undefined;
    const text = showFile(this.root, object, path);
    return text === undefined ? undefined : JSON.stringify({ key, path, text });
  }

  review(key: string): string | undefined {
    if (!isReviewKey(key)) return undefined;
    return JSON.stringify(this.reviews.read(key) ?? { key, body: '', comments: [], viewed: {} });
  }

  /** Store the review of a dyffle, and tell the other viewers. */
  saveReview(key: string, json: string, client?: string): void {
    if (!isReviewKey(key)) throw new Error(`Unknown review "${key}"`);
    const input = readReviewInput(JSON.parse(json));
    const commit = key.startsWith('commit-') ? this.commitOf(key) : undefined;
    if (key.startsWith('commit-') && !commit) throw new Error(`No commit on the branch for "${key}"`);
    const head = commit ? commit.sha : headCommit(this.root);
    const title = commit ? commit.subject : key === 'uncommitted' ? UNCOMMITTED_TITLE : undefined;
    const review: Review = {
      key,
      ...(title ? { title } : {}),
      ...(head ? { headCommit: head } : {}),
      updatedAt: new Date().toISOString(),
      ...input,
    };
    this.reviews.write(review);
    this.emit('review', { key, client: client ?? null, comments: review.comments.length });
  }

  subscribe(send: (event: string, data: unknown) => void): () => void {
    this.listeners.add(send);
    return () => this.listeners.delete(send);
  }

  /* ---------- Work ---------- */

  private emit(event: string, data: unknown = {}): void {
    for (const l of this.listeners) l(event, data);
  }

  private builtView(b?: Built): Pick<LiveView, 'generatedAt' | 'stats'> {
    return b ? { generatedAt: b.generatedAt, stats: b.stats } : {};
  }

  private commitOf(key: string): CommitView | undefined {
    return this.commits.find((c) => commitKey(c.sha) === key);
  }

  private commitFile(sha: string): string {
    return join(this.dir, 'commits', `${sha}.json`);
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (e) {
        this.log(`dyffle watch: ${(e as Error).message}`);
      }
      await sleep(this.opts.interval ?? 1000);
    }
  }

  /** Rebuild what changed: the commits when HEAD or the merge base moved, the live dyffles when the working tree did too. */
  async tick(): Promise<void> {
    const moved = this.base?.commit !== mergeBase(this.root, this.opts.baseRef) || this.head?.commit !== headCommit(this.root);
    const tree = worktreeTree(this.root);
    if (moved || tree !== this.live?.tree) await this.busy('branch', () => this.update(tree));
  }

  /** Let viewers know a build is running; the build itself blocks the event loop. */
  private async busy(what: string, work: () => void): Promise<void> {
    this.emit('status', { building: what });
    await sleep(30);
    try {
      work();
    } finally {
      this.emit('status', { building: null });
    }
  }

  /** Bring every dyffle up to date with the merge base, HEAD and the working tree, and tell the viewers which changed. */
  private update(tree = worktreeTree(this.root)): void {
    const changed: string[] = [];
    const baseMoved = this.ensureBase();
    const head = headCommit(this.root) ?? this.base!.commit;
    if (baseMoved || this.head?.commit !== head) {
      const before = new Set(this.commits.map((c) => c.sha));
      this.syncCommits(head);
      changed.push(...this.commits.filter((c) => !before.has(c.sha)).map((c) => commitKey(c.sha)));
    }
    this.rebuildLive(tree);
    changed.push('live', 'uncommitted');
    this.emit('views', { changed });
  }

  /** The base index at the merge base with baseRef, from cache or built once. Returns true when it changed. */
  private ensureBase(): boolean {
    const commit = mergeBase(this.root, this.opts.baseRef);
    if (this.base?.commit === commit) return false;
    const file = join(this.dir, `base-${commit.slice(0, 12)}.json`);
    let index: Index;
    if (existsSync(file)) index = JSON.parse(readFileSync(file, 'utf8')) as Index;
    else {
      this.log(`Indexing ${this.opts.baseRef} at ${commit.slice(0, 7)}`);
      index = this.inCommit(commit, (project) => buildBaseIndex({ ...project, log: this.log }));
      index.commit = commit;
      writeFileSync(file, JSON.stringify(index));
    }
    this.base = { commit, index };
    return true;
  }

  /**
   * One dyffle per commit from the merge base to HEAD, each against its parent. Each one starts from
   * the codebase index of its parent, which is the previous commit's dyffle rebased, so the merge base
   * is the only commit indexed in full. Dyffles of commits no longer on the branch are removed.
   */
  private syncCommits(head: string): void {
    const list = branchCommits(this.root, this.base!.commit);
    // The codebase index at the previous commit: rebased from its dyffle only when something needs it.
    let prev: { sha: string; merged: Index } | undefined;
    const prevIndex = () => (prev ? rebase(prev.merged, prev.sha) : this.base!.index);
    const commits: CommitView[] = [];
    for (const c of list) {
      const file = this.commitFile(c.sha);
      let merged: Index;
      if (existsSync(file)) merged = JSON.parse(readFileSync(file, 'utf8')) as Index;
      else {
        const started = Date.now();
        merged = this.commitDyffle(c, prevIndex());
        writeFile(file, JSON.stringify(merged));
        this.log(`Commit ${c.sha.slice(0, 7)} ${c.subject}: ${merged.checks!.summary.filesChanged} files changed (${Date.now() - started} ms)`);
      }
      commits.push({ ...c, stats: statsOf(merged) });
      prev = { sha: c.sha, merged };
    }
    this.commits = commits;
    this.head = { commit: head, index: prevIndex() };
    const keep = new Set(commits.map((c) => `${c.sha}.json`));
    for (const f of readdirSync(join(this.dir, 'commits'))) if (!keep.has(f)) rmSync(join(this.dir, 'commits', f), { force: true });
  }

  /** A commit against its parent, indexed from a copy of the commit's files so the working tree is left alone. */
  private commitDyffle(c: BranchCommit, parentIndex: Index): Index {
    const overlay = this.inCommit(c.sha, (project) =>
      buildOverlay({ ...project, diff: diffBetween(this.root, c.parent, c.sha), baseCommit: c.parent, headCommit: c.sha }),
    );
    overlay.pr!.title = c.subject;
    return merge(parentIndex, overlay, { depth: this.opts.depth });
  }

  /** Run `work` on a copy of a commit's files, with the project's options pointed at the copy; the result's root is the project's. */
  private inCommit<T extends Index>(commit: string, work: (project: ProjectOptions) => T): T {
    const tmp = mkdtempSync(join(tmpdir(), 'dyffle-commit-'));
    try {
      const root = extractCommit(this.root, commit, tmp);
      // Packages resolve from the project's own node_modules (and the repository's, in a monorepo).
      const top = git(this.root, ['rev-parse', '--show-toplevel']).trim();
      for (const [from, to] of [[this.root, root], [top, tmp]])
        if (existsSync(join(from, 'node_modules')) && !existsSync(join(to, 'node_modules'))) symlinkSync(join(from, 'node_modules'), join(to, 'node_modules'), 'dir');
      const tsconfig = this.opts.tsconfig ? join(root, relative(this.root, resolve(this.opts.tsconfig))) : undefined;
      const index = work({ ...this.project, root, tsconfig });
      index.root = this.root;
      return index;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** The whole branch (merge base → working tree) and the uncommitted changes (HEAD → working tree), from one loaded program. */
  private rebuildLive(tree: string): void {
    const started = Date.now();
    const analyzer = new Analyzer(this.project);
    const head = headCommit(this.root);
    const dyffle = (from: { commit: string; index: Index }, extra: Partial<OverlayOptions>) =>
      built(
        merge(
          from.index,
          buildOverlay({ ...this.project, analyzer, diff: diffBetween(this.root, from.commit, tree), baseCommit: from.commit, ...(head ? { headCommit: head } : {}), ...extra }),
          { depth: this.opts.depth },
        ),
      );
    const branch = dyffle(this.base!, { baseRef: this.opts.baseRef });
    const uncommitted = dyffle(this.head!, {});
    const parsed = JSON.parse(uncommitted.json) as Index;
    parsed.pr!.title = UNCOMMITTED_TITLE;
    uncommitted.json = JSON.stringify(parsed);
    this.live = { tree, branch, uncommitted };
    writeFile(join(this.dir, 'live.json'), branch.json);
    this.log(`Branch dyffle updated: ${branch.stats.files} files changed, ${uncommitted.stats.files} uncommitted (${Date.now() - started} ms)`);
  }
}

const commitKey = (sha: string) => `commit-${sha}`;

function built(merged: Index): Built {
  return { json: JSON.stringify(merged), generatedAt: merged.generatedAt, stats: statsOf(merged), files: sourceFiles(merged) };
}

function statsOf(merged: Index): DyffleStats {
  const s = merged.checks!.summary;
  return { files: s.filesChanged, additions: s.additions, deletions: s.deletions, symbols: s.symbols.added + s.symbols.modified + s.symbols.removed };
}

/** Paths of the files in a dyffle that exist on its head side. */
function sourceFiles(index: Index): Set<string> {
  return new Set(index.files.filter((f) => f.change?.status !== 'removed').map((f) => f.path));
}

/** Write through a temporary file, so a reader never sees half of it. */
function writeFile(file: string, text: string): void {
  writeFileSync(file + '.tmp', text);
  renameSync(file + '.tmp', file);
}
