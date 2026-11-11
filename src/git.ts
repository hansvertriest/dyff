import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
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

export function tryGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string | undefined {
  try {
    return git(cwd, args, env).trim();
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

/**
 * The ref that keeps the live tree of the worktree `cwd` is in from git gc. Git shares refs between
 * worktrees, so a linked one gets a name of its own. Not refs/worktree: git gc only honours those of
 * the worktree it runs in.
 */
export function liveRef(cwd: string): string {
  const id = worktreeId(cwd);
  return id ? `${WORKTREE_REFS}/${id}/live` : 'refs/dyffle/live';
}

/** Point a ref at an object, a tree as well as a commit. */
export function updateRef(cwd: string, ref: string, object: string): void {
  git(cwd, ['update-ref', ref, object]);
}

/**
 * Delete the refs a removed worktree left behind, so git can collect what they kept; they outlive
 * `git worktree remove`. `root` is any other worktree of the repository and `id` the removed one's
 * worktreeId(). Returns how many refs it deleted, and throws while git still has a worktree with that
 * id, whose session may need them (`git worktree prune` forgets one whose directory is gone).
 */
export function removeWorktreeRefs(root: string, id: string): number {
  if (existsSync(join(gitDirs(root).commonDir, 'worktrees', id))) throw new Error(`Cannot remove the refs of worktree "${id}": git still has this worktree.`);
  const prefix = `${WORKTREE_REFS}/${id}/`;
  const refs = git(root, ['for-each-ref', '--format=%(refname)', WORKTREE_REFS]).split('\n').filter((r) => r.startsWith(prefix));
  for (const ref of refs) git(root, ['update-ref', '-d', ref]);
  return refs.length;
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
 * Whether a tree's objects are there. One process normally; `deep` also walks its subtrees and blobs,
 * which takes as long as the tree is big. Submodules are not followed, and the blobs a partial clone
 * never fetched count as there and are not fetched. That option passes a missing start point too,
 * hence the first check.
 */
function treeIntact(cwd: string, tree: string, deep: boolean): boolean {
  if (tryGit(cwd, ['cat-file', '-e', tree]) === undefined) return false;
  return !deep || tryGit(cwd, ['rev-list', '--objects', '--quiet', '--missing=allow-promisor', tree]) !== undefined;
}

/**
 * The working tree as a git tree, untracked files included and ignored files
 * left out, without touching the real index. A separate index file under .git
 * keeps the stat cache between calls, so an unchanged tree is quick to hash.
 *
 * git gc doesn't read that file, so it can name objects gc has pruned, and git trusts its stat cache
 * instead of hashing the files again: write-tree then fails, or gives a tree that isn't there. Such an
 * index is replaced and the tree written again from the working tree, after calling `onRepair`.
 * `deep` makes this notice missing subtrees and blobs under a tree that is there as well.
 */
export function worktreeTree(cwd: string, opts: { deep?: boolean; onRepair?: () => void } = {}): string {
  const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const own = resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'dyffle-index']).trim());
  const env = { GIT_INDEX_FILE: own };
  const add = () => {
    if (!existsSync(own)) {
      // From the real index, whose objects gc keeps, and which holds the tracked files that are ignored.
      const real = resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'index']).trim());
      if (existsSync(real)) copyFileSync(real, own);
    }
    git(top, ['add', '-A', '--', '.'], env);
  };
  add();
  const tree = tryGit(top, ['write-tree'], env);
  if (tree && treeIntact(top, tree, opts.deep ?? false)) return tree;
  opts.onRepair?.();
  rmSync(own, { force: true });
  add();
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
