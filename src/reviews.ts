import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tryGit } from './git.js';

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
 * The review of one dyffle under `dyffle watch`, stored as .dyffle/reviews/<key>.json: comments, an
 * overall comment and the changed files marked viewed, each with a hash of its diff so a file that
 * changes again counts as not viewed. The key names the dyffle: `live` (the whole branch),
 * `uncommitted`, or `commit-<sha>`.
 */
export interface Review {
  key: string;
  title?: string;
  headCommit?: string;
  updatedAt: string;
  body: string;
  comments: ReviewComment[];
  viewed: Record<string, string>;
}

const REVIEW_KEY = /^(live|uncommitted|commit-[0-9a-f]{40})$/;

/** True for the key of a dyffle that `dyffle watch` keeps a review of. */
export const isReviewKey = (key: string): boolean => REVIEW_KEY.test(key);

/** The dyffles whose code is the working tree: their comments go outdated when the file changes. */
const followsWorkingTree = (key: string) => key === 'live' || key === 'uncommitted';

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

/** The reviews in a directory (<root>/.dyffle/reviews), one file per key. */
export class ReviewStore {
  constructor(readonly dir: string) {}

  read(key: string): Review | undefined {
    const file = join(this.dir, `${key}.json`);
    return isReviewKey(key) && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Review) : undefined;
  }

  write(review: Review): void {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${review.key}.json`);
    writeFileSync(file + '.tmp', JSON.stringify(review, null, 2) + '\n');
    renameSync(file + '.tmp', file);
  }

  comments(key: string): number {
    return this.read(key)?.comments.length ?? 0;
  }

  all(): Review[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json') && isReviewKey(f.slice(0, -5)))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Review);
  }
}

/** The heading a review is listed under: the whole branch, a commit or the uncommitted changes. */
function reviewHeading(r: Review): string {
  if (r.key === 'live') return 'Whole branch (live)';
  if (r.key === 'uncommitted') return 'Uncommitted changes';
  return `Commit ${r.key.slice('commit-'.length, 'commit-'.length + 7)}${r.title ? ': ' + r.title : ''}`;
}

/**
 * Every review in <root>/.dyffle/reviews as Markdown, for an agent to act on: the overall comment
 * and each line comment with its code. Listed as the viewer does: the whole branch, the commits
 * oldest first, then the uncommitted changes. A comment on the working tree (the whole branch or
 * the uncommitted changes) whose line no longer holds that code is marked as outdated.
 */
export function reviewsMarkdown(root: string): string {
  const top = resolve(root);
  const commitTime = (r: Review) => Number(tryGit(top, ['log', '-1', '--format=%ct', r.key.slice('commit-'.length)]) ?? Date.parse(r.updatedAt) / 1000);
  const rank = (r: Review) => (r.key === 'live' ? -Infinity : r.key === 'uncommitted' ? Infinity : commitTime(r));
  const reviews = new ReviewStore(join(top, '.dyffle', 'reviews'))
    .all()
    .filter((r) => r.body.trim() || r.comments.length)
    .map((r) => ({ r, at: rank(r) }))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.r);
  const lineNow = (path: string, line: number): string | undefined => {
    try {
      return readFileSync(join(top, path), 'utf8').split('\n')[line - 1];
    } catch {
      return undefined;
    }
  };
  const out: string[] = [];
  for (const r of reviews) {
    out.push(`## ${reviewHeading(r)}`, '');
    if (r.body.trim()) out.push(r.body.trim(), '');
    const sorted = [...r.comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    for (const c of sorted) {
      const outdated = followsWorkingTree(r.key) && c.side === 'RIGHT' && c.code !== undefined && lineNow(c.path, c.line) !== c.code.replace(/^ $/, '');
      const where = `${c.path}:${c.line}${c.side === 'LEFT' ? ' (removed line)' : ''}${c.symbol?.includes('#') ? ` in \`${c.symbol.slice(c.symbol.indexOf('#') + 1)}\`` : ''}`;
      out.push(`- **${where}**${outdated ? ' (outdated: the line changed since)' : c.outsideDiff ? ' (outside the diff)' : ''}`);
      if (c.code?.trim()) out.push(`  \`\`\`\n  ${c.code}\n  \`\`\``);
      out.push(...c.body.split('\n').map((l) => `  ${l}`), '');
    }
  }
  return out.join('\n');
}
