import { execFileSync } from 'node:child_process';

const MAX_BUFFER = 512 * 1024 * 1024;

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
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

/** File contents at a commit, path relative to `cwd`. */
export function showFile(cwd: string, commit: string, path: string): string | undefined {
  try {
    return git(cwd, ['show', `${commit}:./${path}`]);
  } catch {
    return undefined;
  }
}
