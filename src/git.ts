import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_BUFFER = 512 * 1024 * 1024;

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
}

export function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args).trim();
  } catch {
    return undefined;
  }
}

export function headCommit(cwd: string): string | undefined {
  return tryGit(cwd, ['rev-parse', 'HEAD']);
}

export function mergeBase(cwd: string, ref: string): string {
  return git(cwd, ['merge-base', ref, 'HEAD']).trim();
}

/** Diff of the working tree against a commit, paths relative to `cwd`. */
export function diffAgainst(cwd: string, commit: string): string {
  return git(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', '--relative', commit]);
}

/** Diff between two commits or trees, paths relative to `cwd`. */
export function diffBetween(cwd: string, from: string, to: string): string {
  return git(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', '--relative', from, to]);
}

/** File contents at a commit, path relative to `cwd`. */
export function showFile(cwd: string, commit: string, path: string): string | undefined {
  try {
    return git(cwd, ['show', `${commit}:./${path}`]);
  } catch {
    return undefined;
  }
}

/**
 * The working tree as a git tree, untracked files included and ignored files
 * left out, without touching the real index. A separate index file under .git
 * keeps the stat cache between calls, so an unchanged tree is quick to hash.
 */
export function worktreeTree(cwd: string): string {
  const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const own = resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'dyffle-index']).trim());
  if (!existsSync(own)) {
    const real = resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'index']).trim());
    if (existsSync(real)) copyFileSync(real, own);
  }
  const env = { GIT_INDEX_FILE: own };
  git(top, ['add', '-A', '--', '.'], env);
  return git(top, ['write-tree'], env).trim();
}

/** A commit on the branch, with its first parent. */
export interface BranchCommit {
  sha: string;
  parent: string;
  author: string;
  /** Author date, ISO 8601. */
  date: string;
  subject: string;
}

/** The commits after `from` up to HEAD, oldest first. Only first parents: a merged-in branch counts as its merge commit. */
export function branchCommits(cwd: string, from: string): BranchCommit[] {
  const out = git(cwd, ['log', '--first-parent', '--reverse', '--format=%H%x00%P%x00%an%x00%aI%x00%s', `${from}..HEAD`]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, parents, author, date, subject] = line.split('\0');
      return { sha, parent: parents.split(' ')[0], author, date, subject };
    });
}

/** Write the files of a commit (the whole repository) into `dir`; returns the path of `cwd` inside it. */
export function extractCommit(cwd: string, commit: string, dir: string): string {
  const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const prefix = git(cwd, ['rev-parse', '--show-prefix']).trim();
  mkdirSync(dir, { recursive: true });
  execFileSync('sh', ['-c', 'git archive --format=tar "$1" | tar -x -C "$2"', 'sh', commit, dir], { cwd: top, stdio: ['ignore', 'ignore', 'pipe'] });
  return resolve(dir, prefix);
}
