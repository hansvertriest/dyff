import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { Analyzer, type ProjectOptions } from './analyzer.js';
import { buildBaseIndex, buildOverlay, type Logger } from './indexer.js';
import { commitTree, diffBetween, extractCommit, git, headCommit, mergeBase, showFile, worktreeTree } from './git.js';
import { merge, rebase } from './merge.js';
import type { Index } from './schema.js';
import type { LiveSource } from './serve.js';

/** What Claude (or anyone) writes to .dyffle/inbox/<name>.json to post to the feed. */
export interface PostInput {
  title?: string;
  /** Markdown. */
  message: string;
  author?: string;
  /** Attach a dyffle of everything that changed since the previous post with a change. */
  change?: boolean;
}

/** A post in the feed, stored as .dyffle/posts/<id>.json. */
export interface Post {
  id: number;
  title?: string;
  message: string;
  author: string;
  createdAt: string;
  /** Snapshot commit of the working tree the attached change ends at (kept under refs/dyffle/posts/<id>). */
  snapshot?: string;
  /** Snapshot the attached change starts from. */
  from?: string;
  /** File name of the attached merged index, next to the post. */
  dyffle?: string;
  stats?: { files: number; additions: number; deletions: number; symbols: number };
  /** Why a post that asked for a change has none. */
  note?: string;
  /** Name of the inbox file the post came from. */
  source?: string;
}

export interface WatchOptions extends ProjectOptions {
  /** Branch the work targets, e.g. origin/main. The branch dyffle is taken from its merge base. */
  baseRef: string;
  depth?: number;
  /** How often to look for changed files and new posts, in ms. Default 1000. */
  interval?: number;
  log?: Logger;
}

/** A review comment on one line of a diff, as the viewer writes it. */
export interface ReviewComment {
  id: string;
  path: string;
  line: number;
  /** RIGHT: a new or unchanged line, LEFT: a removed one (GitHub's convention). */
  side: 'LEFT' | 'RIGHT';
  body: string;
  /** The line of code commented on, as it was then. */
  code?: string;
  /** The symbol whose diff the comment was made in. */
  symbol?: string | null;
  created: number;
  /** Made in the whole file on a line the diff doesn't show (GitHub won't take it on the PR). */
  outsideDiff?: boolean;
}

/**
 * The review of one dyffle (the live branch or a post), stored as .dyffle/reviews/<key>.json:
 * comments, an overall comment and the changed files marked viewed, each with a hash of its
 * diff so a file that changes again counts as not viewed.
 */
export interface Review {
  key: string;
  /** The post reviewed, or null for the live branch. */
  post: number | null;
  title?: string;
  headCommit?: string;
  updatedAt: string;
  body: string;
  comments: ReviewComment[];
  viewed: Record<string, string>;
}

const REVIEW_KEY = /^(live|post-\d+)$/;

/** Validate a review sent by the viewer. */
export function readReviewInput(x: unknown): Pick<Review, 'body' | 'comments' | 'viewed'> {
  const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
  if (typeof o.body !== 'string') throw new Error('"body" must be a string');
  if (!Array.isArray(o.comments)) throw new Error('"comments" must be an array');
  for (const c of o.comments as Record<string, unknown>[])
    if (typeof c?.id !== 'string' || typeof c.path !== 'string' || typeof c.line !== 'number' || (c.side !== 'LEFT' && c.side !== 'RIGHT') || typeof c.body !== 'string')
      throw new Error('each comment needs id, path, line, side (LEFT or RIGHT) and body');
  const viewed = o.viewed ?? {};
  if (typeof viewed !== 'object' || Array.isArray(viewed) || Object.values(viewed).some((h) => typeof h !== 'string')) throw new Error('"viewed" must map paths to hashes');
  return { body: o.body, comments: o.comments as ReviewComment[], viewed: viewed as Record<string, string> };
}

/** The state a change is measured from: a snapshot commit and the codebase index at that snapshot. */
interface State {
  snapshot: string;
  index: Index;
}

const LIVE_LABEL = 'Branch (live)';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pad = (id: number) => String(id).padStart(4, '0');

/** Validate a parsed inbox file. */
export function readPostInput(x: unknown): PostInput {
  const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
  if (typeof o.message !== 'string' || !o.message.trim()) throw new Error('"message" must be a non-empty string');
  for (const k of ['title', 'author'] as const) if (o[k] !== undefined && typeof o[k] !== 'string') throw new Error(`"${k}" must be a string`);
  if (o.change !== undefined && typeof o.change !== 'boolean') throw new Error('"change" must be true or false');
  return { message: o.message, title: o.title as string | undefined, author: o.author as string | undefined, change: o.change as boolean | undefined };
}

/**
 * dyffle running next to a project: keeps a dyffle of the whole branch up to
 * date as files change, and turns files dropped in .dyffle/inbox into posts,
 * each a Markdown message with an optional dyffle of what changed since the
 * previous one. Everything it keeps is in <root>/.dyffle.
 */
export class LiveSession implements LiveSource {
  readonly root: string;
  readonly dir: string;
  private readonly project: ProjectOptions;
  private base?: { commit: string; index: Index };
  private live?: { tree: string; json: string; generatedAt: string; files: Set<string> };
  /** Files each post's dyffle shows, read once: only those are served as source. */
  private postFiles = new Map<number, Set<string>>();
  private state?: State;
  private posts: Post[] = [];
  private listeners = new Set<(event: string, data: unknown) => void>();
  private stopped = false;
  private loop?: Promise<void>;

  constructor(private readonly opts: WatchOptions) {
    this.root = resolve(opts.root ?? process.cwd());
    this.dir = join(this.root, '.dyffle');
    this.project = { root: this.root, tsconfig: opts.tsconfig, include: opts.include, exclude: opts.exclude };
  }

  private get log(): Logger {
    return this.opts.log ?? (() => {});
  }

  /** Build the base and the branch dyffle, then keep watching until stop(). */
  async start(): Promise<void> {
    for (const d of ['inbox', 'posts', 'reviews']) mkdirSync(join(this.dir, d), { recursive: true });
    // Keeps .dyffle out of git status and out of working tree snapshots.
    writeFileSync(join(this.dir, '.gitignore'), '*\n');
    this.loadPosts();
    this.loadState();
    this.ensureBase();
    this.rebuildLive(worktreeTree(this.root));
    if (!this.state) {
      // Posts measure change from here, not from the merge base: what was already on the branch isn't part of them.
      const snapshot = commitTree(this.root, this.live!.tree, 'dyffle start', 'refs/dyffle/start');
      this.saveState({ snapshot, index: rebase(JSON.parse(this.live!.json) as Index, snapshot) });
    }
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }

  /** Record where the viewer runs, so `dyffle post` can find out whether watch is running. */
  announce(url: string): void {
    writeFileSync(join(this.dir, 'server.json'), JSON.stringify({ pid: process.pid, url, startedAt: new Date().toISOString() }, null, 2) + '\n');
  }

  /* ---------- LiveSource ---------- */

  labels(): string[] {
    return [LIVE_LABEL, ...this.withDyffle().map((p) => `#${p.id} ${p.title ?? firstLine(p.message)}`)];
  }

  index(i: number): string | undefined {
    if (i === 0) return this.live?.json;
    const p = this.withDyffle()[i - 1];
    return p ? readFileSync(join(this.dir, 'posts', p.dyffle!), 'utf8') : undefined;
  }

  feed(): string {
    const at = new Map(this.withDyffle().map((p, i) => [p.id, i + 1]));
    const comments = (key: string) => this.readReview(key)?.comments.length ?? 0;
    return JSON.stringify({
      live: { generatedAt: this.live?.generatedAt, comments: comments('live') },
      posts: this.posts.map((p) => ({ ...p, ...(at.has(p.id) ? { index: at.get(p.id), comments: comments(`post-${p.id}`) } : {}) })),
    });
  }

  /**
   * The text of a file as the dyffle of the live branch ("live") or of a post ("post-<id>") shows
   * it: from the tree that dyffle was built from, so it matches the map even after the working tree
   * moved on. Only files in that dyffle are served, and not removed ones.
   */
  source(key: string, path: string): string | undefined {
    let object: string | undefined, files: Set<string> | undefined;
    if (key === 'live') [object, files] = [this.live?.tree, this.live?.files];
    else {
      const post = this.posts.find((p) => `post-${p.id}` === key && p.dyffle);
      if (!post) return undefined;
      object = post.snapshot;
      files = this.postFiles.get(post.id);
      if (!files) {
        files = sourceFiles(JSON.parse(readFileSync(join(this.dir, 'posts', post.dyffle!), 'utf8')) as Index);
        this.postFiles.set(post.id, files);
      }
    }
    if (!object || !files?.has(path)) return undefined;
    const text = showFile(this.root, object, path);
    return text === undefined ? undefined : JSON.stringify({ key, path, text });
  }

  review(key: string): string | undefined {
    if (!REVIEW_KEY.test(key)) return undefined;
    const r = this.readReview(key);
    return JSON.stringify(r ?? { key, body: '', comments: [], viewed: {} });
  }

  /** Store the review of the live branch ("live") or of a post ("post-<id>"), and tell the other viewers. */
  saveReview(key: string, json: string, client?: string): void {
    if (!REVIEW_KEY.test(key)) throw new Error(`Unknown review "${key}"`);
    const input = readReviewInput(JSON.parse(json));
    const post = key === 'live' ? undefined : this.posts.find((p) => `post-${p.id}` === key && p.dyffle);
    if (key !== 'live' && !post) throw new Error(`No post with a change for "${key}"`);
    const head = post ? post.snapshot : headCommit(this.root);
    const review: Review = {
      key,
      post: post?.id ?? null,
      ...(post ? { title: post.title ?? firstLine(post.message) } : {}),
      ...(head ? { headCommit: head } : {}),
      updatedAt: new Date().toISOString(),
      ...input,
    };
    const file = join(this.dir, 'reviews', `${key}.json`);
    writeFileSync(file + '.tmp', JSON.stringify(review, null, 2) + '\n');
    renameSync(file + '.tmp', file);
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

  private readReview(key: string): Review | undefined {
    const file = join(this.dir, 'reviews', `${key}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Review) : undefined;
  }

  private withDyffle(): Post[] {
    return this.posts.filter((p) => p.dyffle);
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

  /** New posts first, then the branch dyffle when the working tree or the merge base changed. */
  async tick(): Promise<void> {
    for (const name of this.inbox()) await this.busy(`post ${name}`, () => this.ingest(name));
    const moved = this.ensureBase();
    const tree = worktreeTree(this.root);
    if (moved || tree !== this.live?.tree) await this.busy('branch', () => this.rebuildLive(tree));
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

  /** The base index at the merge base with baseRef, from cache or built once. Returns true when it changed. */
  private ensureBase(): boolean {
    const commit = mergeBase(this.root, this.opts.baseRef);
    if (this.base?.commit === commit) return false;
    const file = join(this.dir, `base-${commit.slice(0, 12)}.json`);
    let index: Index;
    if (existsSync(file)) index = JSON.parse(readFileSync(file, 'utf8')) as Index;
    else {
      this.log(`Indexing ${this.opts.baseRef} at ${commit.slice(0, 7)}`);
      index = this.indexCommit(commit);
      writeFileSync(file, JSON.stringify(index));
    }
    this.base = { commit, index };
    return true;
  }

  /** A base index of a commit, built from a copy of its files so the working tree is left alone. */
  private indexCommit(commit: string): Index {
    const tmp = mkdtempSync(join(tmpdir(), 'dyffle-base-'));
    try {
      const root = extractCommit(this.root, commit, tmp);
      // Packages resolve from the project's own node_modules (and the repository's, in a monorepo).
      const top = git(this.root, ['rev-parse', '--show-toplevel']).trim();
      for (const [from, to] of [[this.root, root], [top, tmp]])
        if (existsSync(join(from, 'node_modules')) && !existsSync(join(to, 'node_modules'))) symlinkSync(join(from, 'node_modules'), join(to, 'node_modules'), 'dir');
      const tsconfig = this.opts.tsconfig ? join(root, relative(this.root, resolve(this.opts.tsconfig))) : undefined;
      const index = buildBaseIndex({ ...this.project, root, tsconfig, log: this.log });
      index.root = this.root;
      index.commit = commit;
      return index;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** The branch from the merge base to a tree of the working tree, merged onto the base. */
  private branchDyffle(tree: string, analyzer: Analyzer): Index {
    const base = this.base!;
    const head = headCommit(this.root);
    const overlay = buildOverlay({
      ...this.project,
      analyzer,
      diff: diffBetween(this.root, base.commit, tree),
      baseRef: this.opts.baseRef,
      baseCommit: base.commit,
      ...(head ? { headCommit: head } : {}),
    });
    return merge(base.index, overlay, { depth: this.opts.depth });
  }

  private rebuildLive(tree: string, merged?: Index): void {
    const started = Date.now();
    const built = !merged;
    merged ??= this.branchDyffle(tree, new Analyzer(this.project));
    const json = JSON.stringify(merged);
    this.live = { tree, json, generatedAt: merged.generatedAt, files: sourceFiles(merged) };
    // dyffle query reads this file at any moment, so it must never be half written.
    writeFileSync(join(this.dir, 'live.json.tmp'), json);
    renameSync(join(this.dir, 'live.json.tmp'), join(this.dir, 'live.json'));
    this.log(`Branch dyffle updated: ${merged.checks!.summary.filesChanged} files changed${built ? ` (${Date.now() - started} ms)` : ''}`);
    this.emit('live', { generatedAt: merged.generatedAt });
  }

  private inbox(): string[] {
    return readdirSync(join(this.dir, 'inbox'))
      .filter((f) => f.endsWith('.json'))
      .sort();
  }

  /** Turn one inbox file into a post, or into <name>.error when it is not a valid post. */
  private ingest(name: string): void {
    const file = join(this.dir, 'inbox', name);
    let input: PostInput;
    try {
      input = readPostInput(JSON.parse(readFileSync(file, 'utf8')));
    } catch (e) {
      // A file still being written gets another look on the next tick.
      if (e instanceof SyntaxError && Date.now() - statSync(file).mtimeMs < 2000) return;
      writeFileSync(file.replace(/\.json$/, '.error'), `${(e as Error).message}\n`);
      unlinkSync(file);
      this.log(`Rejected ${name}: ${(e as Error).message}`);
      return;
    }
    const id = (this.posts.at(-1)?.id ?? 0) + 1;
    const post: Post = {
      id,
      ...(input.title ? { title: input.title } : {}),
      message: input.message,
      author: input.author ?? 'claude',
      createdAt: new Date().toISOString(),
      source: name,
    };
    if (input.change) this.attachChange(post);
    const out = join(this.dir, 'posts', `${pad(id)}.json`);
    writeFileSync(out + '.tmp', JSON.stringify(post, null, 2) + '\n');
    renameSync(out + '.tmp', out);
    unlinkSync(file);
    this.posts.push(post);
    this.log(`Post #${id}${post.title ? ': ' + post.title : ''}${post.dyffle ? ` (${post.stats!.files} files)` : ''}`);
    this.emit('feed', { id });
  }

  /** Snapshot the working tree and attach a dyffle of what changed since the previous snapshot. */
  private attachChange(post: Post): void {
    this.ensureBase();
    const tree = worktreeTree(this.root);
    const snapshot = commitTree(this.root, tree, `dyffle post #${post.id}`, `refs/dyffle/posts/${post.id}`);
    const prev = this.state!;
    post.snapshot = snapshot;
    post.from = prev.snapshot;
    const analyzer = new Analyzer(this.project);
    const branch = this.branchDyffle(tree, analyzer);
    if (tree !== this.live?.tree) this.rebuildLive(tree, branch);
    const diff = diffBetween(this.root, prev.snapshot, snapshot);
    if (!diff.trim()) post.note = 'Nothing changed since the previous post.';
    else {
      const overlay = buildOverlay({ ...this.project, analyzer, diff, baseCommit: prev.snapshot, headCommit: snapshot });
      overlay.pr!.title = post.title ?? firstLine(post.message);
      const merged = merge(prev.index, overlay, { depth: this.opts.depth });
      const s = merged.checks!.summary;
      post.dyffle = `${pad(post.id)}.dyffle.json`;
      post.stats = { files: s.filesChanged, additions: s.additions, deletions: s.deletions, symbols: s.symbols.added + s.symbols.modified + s.symbols.removed };
      writeFileSync(join(this.dir, 'posts', post.dyffle), JSON.stringify(merged));
    }
    this.saveState({ snapshot, index: rebase(branch, snapshot) });
  }

  private loadPosts(): void {
    const dir = join(this.dir, 'posts');
    this.posts = readdirSync(dir)
      .filter((f) => /^\d+\.json$/.test(f))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Post)
      .sort((a, b) => a.id - b.id);
  }

  private loadState(): void {
    const file = join(this.dir, 'state.json');
    if (existsSync(file)) this.state = JSON.parse(readFileSync(file, 'utf8')) as State;
  }

  private saveState(state: State): void {
    this.state = state;
    writeFileSync(join(this.dir, 'state.json'), JSON.stringify(state));
  }
}

/** Paths of the files in a dyffle that exist on its head side. */
function sourceFiles(index: Index): Set<string> {
  return new Set(index.files.filter((f) => f.change?.status !== 'removed').map((f) => f.path));
}

function firstLine(md: string): string {
  const line = md.trim().split('\n')[0].replace(/^#+\s*/, '');
  return line.length > 60 ? line.slice(0, 59) + '…' : line;
}

/**
 * Every review in <root>/.dyffle/reviews as Markdown, for an agent to act on: the overall comment
 * and each line comment with its code. A comment on the live branch whose line no longer holds
 * that code is marked as outdated.
 */
export function reviewsMarkdown(root: string): string {
  const dir = join(resolve(root), '.dyffle', 'reviews');
  if (!existsSync(dir)) return '';
  const reviews = readdirSync(dir)
    .filter((f) => REVIEW_KEY.test(f.replace(/\.json$/, '')) && f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Review)
    .filter((r) => r.body.trim() || r.comments.length)
    .sort((a, b) => (a.post ?? Infinity) - (b.post ?? Infinity));
  const lineNow = (path: string, line: number): string | undefined => {
    try {
      return readFileSync(join(resolve(root), path), 'utf8').split('\n')[line - 1];
    } catch {
      return undefined;
    }
  };
  const out: string[] = [];
  for (const r of reviews) {
    out.push(`## ${r.post === null ? 'Whole branch (live)' : `Post #${r.post}${r.title ? ': ' + r.title : ''}`}`, '');
    if (r.body.trim()) out.push(r.body.trim(), '');
    const sorted = [...r.comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    for (const c of sorted) {
      const outdated = r.post === null && c.side === 'RIGHT' && c.code !== undefined && lineNow(c.path, c.line) !== c.code.replace(/^ $/, '');
      const where = `${c.path}:${c.line}${c.side === 'LEFT' ? ' (removed line)' : ''}${c.symbol?.includes('#') ? ` in \`${c.symbol.slice(c.symbol.indexOf('#') + 1)}\`` : ''}`;
      out.push(`- **${where}**${outdated ? ' (outdated: the line changed since)' : c.outsideDiff ? ' (outside the diff)' : ''}`);
      if (c.code?.trim()) out.push(`  \`\`\`\n  ${c.code}\n  \`\`\``);
      out.push(...c.body.split('\n').map((l) => `  ${l}`), '');
    }
  }
  return out.join('\n');
}
