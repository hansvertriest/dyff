import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { Analyzer, type ProjectOptions } from './analyzer.js';
import { buildBaseIndex, buildOverlay, TOOL_VERSION, type Logger } from './indexer.js';
import { commitTree, deleteWorktreeRefs, diffBetween, extractCommit, git, headCommit, mergeBase, showFile, snapshotRefs, worktreeId, worktreeTree } from './git.js';
import { merge, rebase } from './merge.js';
import { SCHEMA_VERSION, type Index } from './schema.js';
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
  /** Snapshot commit of the working tree the attached change ends at (kept under refs/dyffle/posts/<id>, or refs/dyffle/worktrees/<worktree id>/posts/<id> in a linked worktree). */
  snapshot?: string;
  /** Snapshot the attached change starts from. */
  from?: string;
  /** File name of the attached merged index, next to the post. */
  dyffle?: string;
  stats?: { files: number; additions: number; deletions: number; symbols: number };
  /** Why a post that asked for a change has none. */
  note?: string;
  /** Name of the inbox file the post came from; LiveSession.post() has none. */
  source?: string;
}

export interface WatchOptions extends ProjectOptions {
  /** Branch the work targets, e.g. origin/main. The branch dyffle is taken from its merge base. */
  baseRef: string;
  depth?: number;
  /** How often to look for changed files and new posts, in ms. Default 1000. */
  interval?: number;
  /**
   * Directory for base indexes, to share them between sessions on worktrees of one repository, instead
   * of each building its own in <root>/.dyffle. Created when missing. A file holds one commit and one
   * set of project options (the root's place in the repository, tsconfig, include and exclude).
   */
  baseCacheDir?: string;
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

/** A base index from baseCacheDir, or undefined unless it is whole and this dyffle's own for that commit. */
function readSharedBase(file: string, commit: string): Index | undefined {
  try {
    const i = JSON.parse(readFileSync(file, 'utf8')) as Index;
    const usable = i.kind === 'base' && i.commit === commit && i.schemaVersion === SCHEMA_VERSION && i.tool.version === TOOL_VERSION;
    return usable && [i.modules, i.files, i.nodes].every(Array.isArray) ? i : undefined;
  } catch {
    return undefined;
  }
}

/**
 * dyffle running next to a project: keeps a dyffle of the whole branch up to
 * date as files change, and turns files dropped in .dyffle/inbox into posts,
 * each a Markdown message with an optional dyffle of what changed since the
 * previous one. Everything it keeps is in <root>/.dyffle, except base indexes with baseCacheDir.
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
  /** The end of the line of work serial() keeps. Never rejects. */
  private queue: Promise<void> = Promise.resolve();

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
      // Git reuses the id of a removed worktree: its refs are a dead session's, as nothing here names them.
      const id = this.posts.length ? undefined : worktreeId(this.root);
      if (id) deleteWorktreeRefs(this.root, id);
      // Posts measure change from here, not from the merge base: what was already on the branch isn't part of them.
      const snapshot = commitTree(this.root, this.live!.tree, 'dyffle start', this.snapshotRef('start'));
      this.saveState({ snapshot, index: rebase(JSON.parse(this.live!.json) as Index, snapshot) });
    }
    this.loop = this.run();
  }

  /** Stop watching. Resolves once the loop has ended and every post accepted before this call is in. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
    await this.queue;
  }

  /**
   * Post to the feed directly, without a file in the inbox. Takes its turn with the inbox and with
   * rebuilds, so posts made at the same time get sequential ids and each change measures from the
   * previous one. Resolves with the post once it is stored and the `feed` event is sent.
   *
   * Rejects when the session isn't started or is stopped, with the error of readPostInput on invalid
   * input (no `.error` file: that is how the inbox answers, as it has no caller), and when the post
   * can't be made, e.g. git fails; then nothing is posted and the next post takes its id.
   */
  async post(input: PostInput): Promise<Post> {
    if (this.stopped) throw new Error('Cannot post: this session is stopped. Start a new LiveSession to post again.');
    if (!this.loop) throw new Error('Cannot post: this session is not started. Call start() first.');
    const valid = readPostInput(input);
    const post = await this.serial(() => this.busy('post', () => this.addPost(valid)));
    return structuredClone(post);
  }

  /** Record where the viewer runs, so `dyffle post` can find out whether watch is running. */
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

  /**
   * Run work after everything already queued, one at a time. All that touches posts, snapshots or
   * the branch dyffle goes through here: work awaits (see busy()), and in that gap another post or
   * rebuild must not take the next id or put back an older tree.
   */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const done = this.queue.then(work);
    this.queue = done.then(
      () => {},
      () => {},
    );
    return done;
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
  tick(): Promise<void> {
    return this.serial(async () => {
      for (const name of this.inbox()) await this.busy(`post ${name}`, () => this.ingest(name));
      const moved = this.ensureBase();
      const tree = worktreeTree(this.root);
      if (moved || tree !== this.live?.tree) await this.busy('branch', () => this.rebuildLive(tree));
    });
  }

  /** Let viewers know a build is running; the build itself blocks the event loop. */
  private async busy<T>(what: string, work: () => T): Promise<T> {
    this.emit('status', { building: what });
    await sleep(30);
    try {
      return work();
    } finally {
      this.emit('status', { building: null });
    }
  }

  /** The base index at the merge base with baseRef, from cache or built once. Returns true when it changed. */
  private ensureBase(): boolean {
    const commit = mergeBase(this.root, this.opts.baseRef);
    if (this.base?.commit === commit) return false;
    const shared = this.opts.baseCacheDir;
    this.base = { commit, index: shared ? this.sharedBase(commit, resolve(shared)) : this.ownBase(commit) };
    return true;
  }

  /** The base index kept in this root's .dyffle. */
  private ownBase(commit: string): Index {
    const file = join(this.dir, `base-${commit.slice(0, 12)}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Index;
    const index = this.indexCommit(commit);
    writeFileSync(file, JSON.stringify(index));
    return index;
  }

  /**
   * The base index kept in baseCacheDir, which other sessions and processes read and write too. A
   * file that can't be used is a miss, and failing to write only costs the next session a build.
   */
  private sharedBase(commit: string, dir: string): Index {
    const file = this.sharedBaseFile(commit, dir);
    const cached = readSharedBase(file, commit);
    if (cached) {
      // All else in an index is relative to the root; this one field names the worktree that built it.
      cached.root = this.root;
      return cached;
    }
    if (existsSync(file)) this.log(`Replacing the unusable base index ${file}`);
    const index = this.indexCommit(commit);
    // Sessions can build one commit at once: each writes its own temp file, and the last rename wins.
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, JSON.stringify(index));
      renameSync(tmp, file);
    } catch (e) {
      this.log(`warning: could not store the base index in ${dir}: ${(e as Error).message}`);
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* dir is no directory, so there is no temp file either */
      }
    }
    return index;
  }

  /**
   * base-<commit>.json, with a hash of whatever makes this session's index differ from the default
   * one at that commit: where the root sits in the repository, and the project options. Worktrees
   * agree on these however their own paths differ, so the tsconfig counts relative to the root.
   */
  private sharedBaseFile(commit: string, dir: string): string {
    const { tsconfig, include, exclude } = this.opts;
    const prefix = git(this.root, ['rev-parse', '--show-prefix']).trim();
    const variant = {
      ...(prefix ? { prefix } : {}),
      ...(tsconfig ? { tsconfig: relative(this.root, resolve(tsconfig)) } : {}),
      ...(include?.length ? { include } : {}),
      ...(exclude?.length ? { exclude } : {}),
    };
    const suffix = Object.keys(variant).length ? `-${createHash('sha256').update(JSON.stringify(variant)).digest('hex').slice(0, 12)}` : '';
    return join(dir, `base-${commit.slice(0, 12)}${suffix}.json`);
  }

  /** A base index of a commit, built from a copy of its files so the working tree is left alone. */
  private indexCommit(commit: string): Index {
    this.log(`Indexing ${this.opts.baseRef} at ${commit.slice(0, 7)}`);
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
    this.addPost(input, name);
  }

  /** Make a post, however it came in. One from the inbox (`source`, the file's name) leaves the inbox once stored. */
  private addPost(input: PostInput, source?: string): Post {
    const id = (this.posts.at(-1)?.id ?? 0) + 1;
    const post: Post = {
      id,
      ...(input.title ? { title: input.title } : {}),
      message: input.message,
      author: input.author ?? 'claude',
      createdAt: new Date().toISOString(),
      ...(source ? { source } : {}),
    };
    if (input.change) this.attachChange(post);
    const out = join(this.dir, 'posts', `${pad(id)}.json`);
    writeFileSync(out + '.tmp', JSON.stringify(post, null, 2) + '\n');
    renameSync(out + '.tmp', out);
    if (source) unlinkSync(join(this.dir, 'inbox', source));
    this.posts.push(post);
    this.log(`Post #${id}${post.title ? ': ' + post.title : ''}${post.dyffle ? ` (${post.stats!.files} files)` : ''}`);
    this.emit('feed', { id });
    return post;
  }

  /**
   * The ref that keeps a snapshot. Git shares refs between worktrees, so sessions on linked worktrees
   * each take a namespace of their own. Not refs/worktree: git gc only honours those of the worktree it
   * runs in, so gc in any other worktree would remove the snapshots.
   */
  private snapshotRef(name: string): string {
    return `${snapshotRefs(this.root)}/${name}`;
  }

  /** Snapshot the working tree and attach a dyffle of what changed since the previous snapshot. */
  private attachChange(post: Post): void {
    this.ensureBase();
    const tree = worktreeTree(this.root);
    const snapshot = commitTree(this.root, tree, `dyffle post #${post.id}`, this.snapshotRef(`posts/${post.id}`));
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
