import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

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

/** The git directory of this worktree and the one all worktrees share, absolute, with symlinks resolved. */
function gitDirs(cwd: string): { gitDir: string; commonDir: string } {
  // git may answer with one absolute path and one relative to the physical cwd.
  const here = realpathSync(cwd);
  const [gitDir, commonDir] = git(cwd, ['rev-parse', '--git-dir', '--git-common-dir']).trim().split('\n').map((p) => realpathSync(resolve(here, p)));
  return { gitDir, commonDir };
}

/** git's own id of the linked worktree `cwd` is in (.git/worktrees/<id>), or undefined in the main worktree. */
export function worktreeId(cwd: string): string | undefined {
  const { gitDir, commonDir } = gitDirs(cwd);
  return gitDir === commonDir ? undefined : basename(gitDir);
}

const WORKTREE_REFS = 'refs/dyffle/worktrees';

/** The namespace of the refs that keep snapshots of the worktree `cwd` is in. */
export function snapshotRefs(cwd: string): string {
  const id = worktreeId(cwd);
  return id ? `${WORKTREE_REFS}/${id}` : 'refs/dyffle';
}

/** Delete the snapshot refs of a linked worktree id, whatever its state. Returns how many there were. */
export function deleteWorktreeRefs(cwd: string, id: string): number {
  const prefix = `${WORKTREE_REFS}/${id}/`;
  const refs = git(cwd, ['for-each-ref', '--format=%(refname)', WORKTREE_REFS]).split('\n').filter((r) => r.startsWith(prefix));
  for (const ref of refs) git(cwd, ['update-ref', '-d', ref]);
  return refs.length;
}

/**
 * Delete the snapshot refs a removed worktree left behind, so git can collect its snapshots; they
 * outlive `git worktree remove`. `root` is any other worktree of the repository and `id` the removed
 * one's worktreeId(). Other worktrees' refs stay. Returns how many refs it deleted, and throws while
 * git still has a worktree with that id, whose session may need them (`git worktree prune` forgets
 * one whose directory is gone).
 */
export function removeWorktreeRefs(root: string, id: string): number {
  if (existsSync(join(gitDirs(root).commonDir, 'worktrees', id))) throw new Error(`Cannot remove the refs of worktree "${id}": git still has this worktree.`);
  return deleteWorktreeRefs(root, id);
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

/** A commit of a tree on top of HEAD, kept from garbage collection under `ref` when given. */
export function commitTree(cwd: string, tree: string, message: string, ref?: string): string {
  const parent = headCommit(cwd);
  // Snapshot commits never reach a branch; a fixed identity keeps them working without git config.
  const who = { GIT_AUTHOR_NAME: 'dyffle', GIT_AUTHOR_EMAIL: 'dyffle@localhost', GIT_COMMITTER_NAME: 'dyffle', GIT_COMMITTER_EMAIL: 'dyffle@localhost' };
  const sha = git(cwd, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], who).trim();
  if (ref) git(cwd, ['update-ref', ref, sha]);
  return sha;
}

/** Write the files of a commit (the whole repository) into `dir`; returns the path of `cwd` inside it. */
export function extractCommit(cwd: string, commit: string, dir: string): string {
  const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const prefix = git(cwd, ['rev-parse', '--show-prefix']).trim();
  mkdirSync(dir, { recursive: true });
  execFileSync('sh', ['-c', 'git archive --format=tar "$1" | tar -x -C "$2"', 'sh', commit, dir], { cwd: top, stdio: ['ignore', 'ignore', 'pipe'] });
  return resolve(dir, prefix);
}
