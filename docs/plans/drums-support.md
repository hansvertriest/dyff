# dyffle: what drums needs

**drums** is a new, separate app (its spec is in `../drums/docs/spec.md`). It runs several Claude Code agents in parallel per workspace, shows what they make as living artifacts, and uses dyffle as its code-review engine. drums owns the dyffle lifecycle: it imports dyffle as a library and runs one `LiveSession` per git worktree **in its own process**. It does not spawn `dyffle watch`, and agents don't start dyffle themselves.

This plan covers the changes dyffle needs for that. Each item is independent enough to land as its own commit.

## Ground rules

- **Library first.** Every capability lives in `src/` as an exported function or method (re-exported from `src/index.ts`). The CLI in `src/cli.ts` stays a thin wrapper over it.
- **Nothing existing changes behavior.** Current CLI output, index JSON and `.dyffle/` files stay the same. `npm test` passes before and after each item.
- **Tests:** add cases to `test/dyffle.test.mjs` (Node's test runner, `describe`/`it`, the NestJS and Vue fixtures in `test/fixtures`).
- **Docs:** update `README.md` for anything user-visible (new command, new option).
- Commit only when the user asks; the user reviews each item.

## 1. Extract the reach walk

**Why:** `query` (item 2) needs "which routes and tests does this node reach" for **any** node, not only changed ones. Today that walk is inlined in `runChecks` in `src/merge.ts` (the loop over `seeds` that fills `affected`, `tests` and `untested`, around line 240).

**Do:**
- Move the walk into an exported function, e.g. `reach(index, id, { depth })` in a new `src/reach.ts`, returning the route chains (same shape as `AffectedRoute`, with `changed` set to the start node) and the test files that reach it.
- It needs the same inputs the loop uses: nodes by id, the type-only reference pairs, the depth limit (default 8, same as `--depth`).
- `runChecks` calls `reach` for each seed. Its output must stay identical.

**Done when:** existing tests pass unchanged, and a new test calls `reach` on an **unchanged** fixture symbol and gets its route chain and test files.

## 2. `query()`: the impact of one symbol or file

**Why:** agents need to ask "what is this connected to, and what did the branch do to it?" without reading the whole merged index. In drums this becomes the `impact` tool. In a terminal it's `dyffle query`.

**Do:** add `src/query.ts` exporting `query(index, target?, opts?)` and a `QueryResult` type.

- **Resolve `target`:** a node id, a `Class.method` / `Class` / function name, or a file path (project-relative). A name matching several nodes returns `{ candidates: [...] }` with id, kind and file for each, and nothing else.
- **For one node, return:**
  - `node`: id, kind, file, range, signature
  - `change`: status, `signatureChanged`, `previousSignature` (from `node.change`), or null
  - `callers`: `references`, split into `touched` (the caller is changed too) and `untouched`
  - `calls`: `uses` minus `typeUses`
  - `routes`: from `reach()`, as `{ route, chain }`
  - `tests`: test files from `reach()`
  - `broken`: `index.checks.danglingReferences` entries where this node is `from` or `to`
- **For a file:** the same per top-level symbol, plus the file's own change status and imports.
- **No target:** a branch summary from `index.checks`: dangling references, signature changes with callers outside the branch, new module dependencies, new module and file cycles, and `untested`.
- Keep the result small: ids and short labels, no hunks. An agent calls it often.

**Done when:** tests cover a changed symbol (signature change with untouched callers), an unchanged symbol (routes and tests via `reach`), an ambiguous name (candidates), a file, and the no-target summary.

## 3. `dyffle query` command

**Do:** `dyffle query [target] [--index <merged.json>] [--json] [--depth n]`.

- With no `--index`, read `.dyffle/live.json` under `--root` (what `dyffle watch` keeps up to date). With no live file either, give a clear error naming both options.
- Default output is short Markdown meant for an agent: what the node is, change, callers (untouched first), routes as chains, tests, broken references. `--json` prints the `QueryResult`.
- Add it to the usage text at the top of `src/cli.ts` and to the README's CLI section, next to `dyffle comments`.

**Done when:** the command works against a fixture's merged index in a test, both formats.

## 4. Shared base-index cache

**Why:** every worktree builds `.dyffle/base-<commit>.json` for itself. Five drums workspaces on the same `main` commit index `main` five times.

**Do:** add `baseCacheDir?: string` to `WatchOptions`. When set, `ensureBase()` (in `src/live.ts`) reads and writes `base-<commit>.json` there instead of in `<root>/.dyffle/`. Without it, behavior is unchanged. Write atomically (temp file + rename) so two sessions building the same commit don't corrupt it.

**Done when:** two `LiveSession`s on two worktrees of the same commit build the base once (test: the second one logs no "Indexing …" line).

## 5. Pausing and resuming a session

**Why:** drums keeps sessions running only for workspaces that are open or have an agent at work, and stops the rest. A stopped session must resume where it was.

**Do:**
- Verify that `stop()` followed by a new `LiveSession(...).start()` on the same root keeps the posts and does **not** take a new start snapshot (`start()` only snapshots when no state is loaded; confirm with a test).
- Add `LiveSession.unannounce()`, which removes `.dyffle/server.json` if it holds this process's pid. Today only the CLI's `quit` handler does this, and drums needs it too.

**Done when:** a test posts with `change: true`, stops, starts a new session, and the next post's change measures from the previous post, not from a new start.

## 6. Posting without the inbox

**Why:** drums' `checkpoint` tool runs in the same process as the session. Writing a file to `.dyffle/inbox/` and polling for it works, but it is slow and indirect.

**Do:** a public `LiveSession.post(input: PostInput): Promise<Post>` that runs the same code the inbox path runs: validation via `readPostInput`, snapshot when `change: true`, the `feed` event. The inbox loop calls the same internal function. Posts made either way must be indistinguishable.

**Done when:** a test posts once through `post()` and once through the inbox, and both produce the same post files.

## 7. `--port 0` in the CLI

`src/cli.ts` reads the port with `v.port ? Number(v.port) : undefined`, so `--port 0` falls back to 4173. Use `v.port !== undefined`. `serve()` already reports the real port in its URL.

## Later, not now: the map as a module

The viewer (`viewer/index.html`) is one file. drums will first embed it in an iframe fed by its own server. Splitting the map renderer and diff sheet into an importable module is worth doing once drums proves itself; it is not part of this plan.

## Order

1 → 2 → 3, then 4, 5, 6, 7 in any order. drums can start right away against the current release (linked with `file:../dyff`). It needs items 2, 5 and 6 before its `impact` tool, workspace pausing and in-process checkpoints, and item 4 before it scales past a few workspaces.
