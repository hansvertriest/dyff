# dyffle

Turn a NestJS or Vue codebase into a JSON graph of modules, files, classes and functions, with each one linked to the exact places it is referenced. Then overlay a pull request on that graph to see what the PR really touches.

For a PR, dyffle reports:

- every changed symbol (added / modified / removed), with its own slice of the diff
- **references the PR breaks**: unchanged code that still calls a symbol the PR removed or renamed
- **signature changes** and the callers outside the PR that should be checked
- **new module dependencies** and **new circular dependencies** (including `forwardRef`)
- **new circular imports between files** (runtime imports; type-only imports and tests don't count)
- **affected routes**: callers are followed upward to HTTP routes, message patterns, GraphQL resolvers, cron jobs and event handlers, e.g. `findOne → OrdersService.createForUser → OrdersController.create → POST /orders/:userId`
- **test reach**: which spec files reach each changed symbol, and which changed code no test reaches

The analysis uses the TypeScript compiler (via [ts-morph](https://ts-morph.com)), so references are exact: two methods both named `create` are never confused, and path aliases and barrel files are resolved.

## Vue projects

`.vue` single-file components are indexed next to the `.ts` files:

- the `<script>` and `<script setup>` blocks are analyzed with the type checker, so top-level functions and variables become nodes at their real line numbers
- the template counts as a reference from the component to every component it renders (`<OrderRow>` or `<order-row>`) and every name it uses in bindings, events and `{{ }}`. A change to the template or styles marks the component as modified, and shows as its own Template or Styles diff next to the script's symbols
- vue-router route records (`{ path: '/orders/:id', component: ... }`, including `children` and lazy `() => import('./X.vue')`) are entry points, so a changed composable is followed up to the pages that use it: `formatTotal → OrderRow.vue → OrderDetail.vue → PAGE /orders/:id`
- a Vite `tsconfig.json` that only lists `references` is followed to `tsconfig.app.json` for path aliases such as `@/*`

Options API members (`methods`, `computed`, ...) are not separate nodes: they count as part of the component file.

## Install

```sh
npm install --save-dev dyffle
```

Requires Node 18.17+ and git (for `--base-ref`).

## How it works

dyffle works in two layers:

1. **Base index**: the whole codebase on `main`, indexed once (e.g. in CI on every merge) and cached.
2. **PR overlay**: only the files the PR changed. The whole PR branch is loaded so the type checker can resolve references, but only the changed files are walked. Each changed file is re-indexed in full and compared with its base version, so every symbol gets a `change` status.

`merge` swaps the overlay into the base index. References from unchanged files come from the base index (they are identical to `main`), and the checks run against the merged graph.

## CLI

```sh
# On main: index the whole codebase
dyffle index -o base.json

# On the PR branch: index the changed files (diff from the merge base with origin/main)
dyffle overlay --base-ref origin/main -o overlay.json

# Merge, run the checks, and write a Markdown summary
dyffle merge base.json overlay.json -o merged.json
dyffle report merged.json -o report.md

# Or overlay + merge + report in one step
dyffle pr --base base.json --base-ref origin/main -o merged.json --report report.md
```

```sh
# Look at the result
dyffle serve merged.json                    # interactive PR map on http://127.0.0.1:4173
dyffle html merged.json -o pr-map.html      # the same page as one self-contained file
dyffle report merged.json --map             # Markdown with a Mermaid module map (renders on GitHub)

# Keep a dyffle section up to date inside a PR description
gh pr view 12 --json body -q .body > body.md
dyffle report merged.json --map --embed-in body.md -o body.md
gh pr edit 12 --body-file body.md
```

`--embed-in` places the report between `<!-- dyffle:start -->` and `<!-- dyffle:end -->` markers: an earlier dyffle section is replaced, the rest of the description is kept.

Instead of `--base-ref` you can pass a diff: `--diff pr.diff`, or `--diff -` for stdin (for example `gh pr diff 123 | dyffle overlay --diff -`). The working tree must be the PR's head, and diff paths must be relative to `--root`. dyffle rebuilds the base version of each changed file by reverse-applying the diff.

| Option | |
| --- | --- |
| `--root <dir>` | Directory node ids are relative to (default: current directory) |
| `--tsconfig <file>` | Compiler options and path aliases (default: `<root>/tsconfig.json`) |
| `--include <glob>` | Files to index, repeatable (default: all `.ts` and `.vue` files under root) |
| `--exclude <glob>` | Extra files to skip, repeatable (`node_modules`, `dist`, `build`, `coverage`, `.dyffle` and `.d.ts` are always skipped) |
| `--depth <n>` | How many caller steps to follow for routes and tests (default 8) |
| `-o, --out <file>` | Write to a file instead of stdout |
| `--pretty` | Indented JSON |
| `-q, --quiet` | No progress output on stderr |

### Commit by commit

`serve` and `html` also take several merged indexes, and the page gets a commit picker (← → and a list) to switch between them. You stay on the same module or folder when it exists in the other one. Each is listed under its file name, in the order given. For example, every commit of a branch against its parent:

```sh
git checkout -q main && dyffle index -q -o base.json
files=()
for c in $(git rev-list --reverse main..feature); do
  git checkout -q $c
  f="$(git log -1 --format='%h %s' | tr '/' '-').json"
  dyffle pr -q --base base.json --base-ref "$c^" -o "$f" && files+=("$f")
  dyffle index -q -o base.json
done
git checkout -q feature
dyffle serve "${files[@]}"
```

### Review comments

In `dyffle serve` or a `dyffle html` page, hover any diff line and click **+** to comment on it. The summary lists your comments and has a box for an overall comment. Comments stay in your browser, per head commit, until you delete them. (Under `dyffle watch` they are kept in the project instead; see below.)

A changed file's sidebar has a **Viewed** switch, and the map shows an eye on boxes that still hold changed files you haven't viewed. A file is viewed for the diff you saw: when its diff changes, it shows as **Changed since viewed** and counts as not viewed again.

**Copy comments** copies JSON that is the body of GitHub's [create a review](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request) call (`commit_id`, `body`, `comments` with `path`/`line`/`side`), plus a `dyffle.context` list with each comment's line of code and symbol (and, under `watch`, comments outside the diff, which `comments` leaves out). Paste it to Claude to put on the PR, or post it yourself:

```sh
pbpaste | gh api repos/{owner}/{repo}/pulls/12/reviews --input -
```

It has no `event`, so GitHub creates a pending review that you submit from the PR page.

### Live, next to Claude Code: `dyffle watch`

Run dyffle next to a project while you (or Claude Code) work on it:

```sh
dyffle watch --base-ref origin/main
```

It serves the viewer on http://127.0.0.1:4173 with two things in it:

- **The whole branch, live.** A dyffle of the branch against its merge base with `--base-ref`, rebuilt whenever a file changes. Uncommitted and untracked files are included; ignored ones are not. The page updates on its own (unless you are writing a review comment: then it offers the update).
- **A feed of posts.** A post is a Markdown message, optionally with a dyffle of what changed since the previous post that had one. Opening a post's change shows it on the map; ← → in the picker step through them. In a post, a symbol or file in backticks (`` `UsersService.findOne` ``, `` `src/users/users.service.ts` ``) links to it on the map.

Post from the command line. `dyffle post` waits until the post is in and prints its number:

```sh
dyffle post --change --title "Add JWT guard" -m "Guards \`UsersController\`. The login route stays public."
dyffle post -m "Should \`/users/legacy\` keep working? I left it alone for now."
dyffle post --change --message-file notes.md
```

Or write a JSON file to `.dyffle/inbox/` (any name ending in `.json`). dyffle takes it in within a second and removes it, or replaces it with `<name>.error` when it is not a valid post:

```json
{ "title": "Add JWT guard", "message": "Markdown…", "change": true, "author": "claude" }
```

Only `message` is required. `change: true` takes a snapshot of the working tree and attaches what changed since the previous snapshot. The first one is taken when `watch` starts, so a post never includes what was already on the branch. Snapshots are commits kept under `refs/dyffle/` and are never on a branch, and the real git index is not touched. Everything else lives in `.dyffle/` in the project, which ignores itself in git:

| | |
| --- | --- |
| `.dyffle/inbox/` | Posts to take in |
| `.dyffle/posts/0001.json` | A post: `id`, `title`, `message`, `author`, `createdAt`, and with a change `snapshot`, `from`, `stats` and `dyffle` (the file name of its merged index, `0001.dyffle.json`) |
| `.dyffle/live.json` | The merged index of the whole branch, as it is now |
| `.dyffle/base-<commit>.json` | The base index at the merge base, built once (from a copy of that commit, not the working tree) |
| `.dyffle/reviews/<key>.json` | Your review of the live branch (`live`) or of a post (`post-<id>`), see below |
| `.dyffle/server.json` | The URL and process of the running `watch` |

A change you make between two posts is part of the next post with a change. Stop `watch` with Ctrl+C; posts are kept and the feed picks up where it left off next time. Delete `.dyffle/` to start over.

**Reviewing under `watch`.** Comments, the overall comment and viewed files are kept in `.dyffle/reviews/` instead of the browser: one review for the live branch and one per post with a change. Every open page shares them (your laptop and your phone, or `localhost` and a network address), and changes made on one page show on the others. The feed shows how many comments each change has.

**Whole files.** A changed file's sidebar has a **Diff | Whole file** switch. The whole file is the file with its diff laid over it: added lines marked, removed lines where they were. An unchanged file shows whole. A symbol's **Show in file** opens its file at the symbol. The text comes from the git tree the dyffle was built from, so it matches the map even when the working tree has moved on. Only files in that dyffle are served.

Every line of a whole file takes comments. A comment on a line the diff doesn't show is marked **outside the diff**: GitHub won't take it on a PR, so **Copy comments** leaves it out of `comments` and lists it, with `outsideDiff: true`, in `dyffle.context` (which holds every comment).

A comment on the live branch stays on its line while the code moves on. When the line no longer holds the code it was made on, the comment leaves the diff and is listed in the review as **outdated**, with the old code.

`dyffle comments` prints every review as Markdown, for Claude to act on: the overall comment, then each comment with its file, line, symbol and code, with outdated ones and ones outside the diff marked:

~~~md
## Post #2: Add JWT guard

- **src/users/users.controller.ts:14 in `UsersController.findOne`**
  ```
  @Get(':id')
  ```
  Shouldn't this one stay public?
~~~

The files themselves are JSON (`key`, `post`, `title`, `headCommit`, `body`, `comments` with `path`/`line`/`side`/`body`/`code`/`symbol` and `outsideDiff`, and `viewed`: path → hash of the diff that was viewed).

To have Claude Code post its work and read your review, add this to the project's `CLAUDE.md`:

```md
## dyffle
`dyffle watch` runs next to this project and shows the user a review feed. Post to it with `npx dyffle post`:
- After each coherent change (a feature step, a fix, a refactor), run `npx dyffle post --change --title "<short title>" -m "<markdown>"`: what you changed and why, and what to look at. Put symbols and files in backticks so they link to the map.
- For a question, a plan or a status update without a change, leave out `--change`.
- The user reviews in dyffle. Run `npx dyffle comments` before starting the next step and when the user mentions their review; address each comment, and say in your next post what you changed for which comment.
- If it says watch is not running, carry on without posting.
```

### Asking about one symbol: `dyffle query`

`dyffle query` tells an agent what a symbol or file is connected to and what the branch did to it, without reading the whole index:

```sh
dyffle query UsersService.findOne            # the impact of one symbol
dyffle query src/users/users.service.ts      # of a file, symbol by symbol
dyffle query                                 # a summary of the branch
dyffle query findOne --index merged.json --json
```

The target is a node id, a `Class.method`, `Class` or function name, or a file path relative to `--root` (`./src/foo.ts` and an absolute path under `--root` work too). A name that matches several nodes lists them with their ids. With no `--index` it reads `.dyffle/live.json` under `--root`, which `dyffle watch` keeps up to date; without that file either it says so and exits with 1, as it does when nothing matches.

| Option | |
| --- | --- |
| `--index <merged.json>` | The index to read (default: `<root>/.dyffle/live.json`) |
| `--json` | Print the full [`QueryResult`](#api) instead of Markdown |
| `--depth <n>` | How many caller steps to follow for routes and tests (default 8) |

The Markdown is short, for an agent: what the node is, its change, callers (untouched first), routes as chains, tests and broken references. A class or file lists its members or symbols and only what each one has. A list stops at 25 items and says how many are left; `--json` has them all, and also what the node calls.

~~~md
## `src/users/users.service.ts#UsersService.findOne`

method, lines 12-18: `async (id: number, withOrders = false)`

**Change:** modified, signature changed (was `async (id: number)`)

**Callers, untouched (1):**
- `src/reports/reports.service.ts#ReportsService.userSummary`

**Callers, touched too (1):**
- `src/users/users.controller.ts#UsersController.findOne`

**Routes (1):**
- **GET /api/reports/users/:id** via `UsersService.findOne` → `ReportsService.userSummary` → `ReportsController.user`

**None:** tests, broken references.
~~~

### In CI: a PR map in every PR description (GitHub Actions)

Add dyffle as a dev dependency (`npm install --save-dev dyffle`), then add `.github/workflows/dyffle.yml`. On every push to a PR it indexes the target branch at the merge base, overlays the PR, keeps a dyffle section in the PR description up to date, and attaches the interactive page to the run:

```yaml
name: dyffle PR map
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: dyffle-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  map:
    # Forks and Dependabot get a read-only token and can't edit the description.
    if: github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
      - uses: actions/setup-node@v7
        with: { node-version: 22, cache: npm }
      - run: npm ci --ignore-scripts

      - name: Map the PR
        env:
          BASE_REF: origin/${{ github.base_ref }}
        run: |
          base_sha=$(git merge-base "$BASE_REF" HEAD)
          git worktree add --detach "$RUNNER_TEMP/base" "$base_sha"
          ln -s "$PWD/node_modules" "$RUNNER_TEMP/base/node_modules"
          npx dyffle index --root "$RUNNER_TEMP/base" -o "$RUNNER_TEMP/base.json"
          npx dyffle pr --base "$RUNNER_TEMP/base.json" --base-ref "$BASE_REF" -o "$RUNNER_TEMP/merged.json"
          mkdir -p "$RUNNER_TEMP/page"
          npx dyffle html "$RUNNER_TEMP/merged.json" -o "$RUNNER_TEMP/page/dyffle-pr-${{ github.event.pull_request.number }}.html"

      - id: upload
        uses: actions/upload-artifact@v7
        with:
          path: ${{ runner.temp }}/page/dyffle-pr-${{ github.event.pull_request.number }}.html
          archive: false
          overwrite: true

      - name: Update the PR description
        env:
          GH_TOKEN: ${{ github.token }}
          PR_URL: repos/${{ github.repository }}/pulls/${{ github.event.pull_request.number }}
          MAP_URL: ${{ steps.upload.outputs.artifact-url }}
        run: |
          gh api "$PR_URL" --jq '.body // ""' > "$RUNNER_TEMP/body.md"
          npx dyffle report "$RUNNER_TEMP/merged.json" --map --link "$MAP_URL" \
            --embed-in "$RUNNER_TEMP/body.md" -o "$RUNNER_TEMP/new-body.md"
          if ! cmp -s "$RUNNER_TEMP/body.md" "$RUNNER_TEMP/new-body.md"; then
            gh api -X PATCH "$PR_URL" -F "body=@$RUNNER_TEMP/new-body.md" --silent
          fi
```

For large codebases, build the base index once per merge to `main` and download it in the PR job instead of indexing the base branch every time.

## API

```ts
import { buildBaseIndex, buildOverlay, merge, markdownReport } from 'dyffle';

const base = buildBaseIndex({ root: '/path/to/repo' });
const overlay = buildOverlay({ root: '/path/to/repo', baseRef: 'origin/main' });
const merged = merge(base, overlay);

merged.checks.danglingReferences; // [{ from, to, file, maybeRenamedTo? }]
console.log(markdownReport(merged));
```

All types of the JSON format are exported (`Index`, `SymbolNode`, `ModuleInfo`, `Checks`, ...).

`query` answers "what is this connected to, and what did the branch do to it?" without reading the whole index. It keeps to ids and short labels, no hunks:

```ts
import { query } from 'dyffle';

query(merged, 'UsersService.findOne', { depth: 8 }); // { node, change, callers: { touched, untouched }, calls, routes, tests, broken }
query(merged, 'UsersService');                       // a class adds `members`: the same for each of its members
query(merged, 'src/users/users.service.ts');         // { file: { path, change, imports }, symbols: [...] }, the file node first
query(merged, 'findOne');                            // several matches: { candidates: [{ id, kind, file }] }
query(merged);                                       // { summary: { danglingReferences, signatureChanges, newModuleDependencies, newCycles, newFileCycles, untested } }
```

The target is a node id, a `Class.method`, `Class` or function name, a bare member name, or a project-relative file path. It throws when nothing matches, and on a summary of an index without `checks`.

`queryMarkdown(result)` turns any of these results into the short Markdown of `dyffle query`.

`LiveSession` is what `dyffle watch` runs. In the same process, post to its feed directly instead of through `.dyffle/inbox/`:

```ts
import { LiveSession } from 'dyffle';

const session = new LiveSession({ root: '/path/to/repo', baseRef: 'origin/main' });
await session.start();
const post = await session.post({ title: 'Add JWT guard', message: 'Markdown…', change: true });
await session.stop();
```

`post` takes the same input and makes the same post as an inbox file, except that the post has no `source` (the name of the inbox file). Posts take turns with the inbox and with rebuilds of the live branch, so posts made at the same time get sequential ids, and each change measures from the previous one. It rejects on invalid input with the error an inbox file's `<name>.error` would hold, without writing that file, and on a session that isn't started or is stopped. `stop()` waits for posts already accepted. A stopped session stays stopped; a new `LiveSession` on the same root picks up where it left off.

Sessions on worktrees of one repository can share their base indexes, so a commit is indexed once and not once per worktree. Give them the same `baseCacheDir`:

```ts
const session = new LiveSession({ root: '/path/to/worktree', baseRef: 'origin/main', baseCacheDir: '/path/to/cache' });
```

The directory is created when missing and holds `base-<commit>.json` instead of `<root>/.dyffle/`; everything else stays in `.dyffle/`. The output is what a session building its own base would produce. A session whose root is a subfolder of the repository, or that sets `tsconfig`, `include` or `exclude`, gets an index of its own, `base-<commit>-<hash>.json`: the hash covers the subfolder, the tsconfig's path relative to the root, and both glob lists as written, so worktrees with the same options share a file. Sessions and processes can build the same commit at once: files appear whole and the last one wins, so at worst a commit is indexed twice. A file that can't be read, or that another dyffle version wrote, is rebuilt and replaced. Failing to write the file logs a warning and the session carries on.

One thing the cache can't tell apart is `node_modules`: packages resolve from the worktree that builds the index. A worktree without its dependencies installed can build a poorer index, and the others then read it too, so install before starting the first session on a commit. Nothing removes old files from the directory.

## JSON format

The base index, the overlay and the merged result share one format (`schemaVersion: 1`):

```jsonc
{
  "kind": "base" | "overlay" | "merged",
  "globalPrefix": "api",
  "modules": [{ "id": "src/users", "name": "UsersModule", "declared": true, "imports": [...], "providers": [...], "controllers": [...], "exports": [...] }],
  "files":   [{ "path": "src/users/users.service.ts", "module": "src/users", "test": false, "imports": [...] }],
  "nodes": [
    {
      "id": "src/users/users.service.ts#UsersService.findOne",
      "kind": "method",
      "module": "src/users",
      "range": [19, 23],
      "signature": "async (id: number)",
      "uses": ["src/users/user.entity.ts#User"],          // outgoing, exact
      "typeUses": ["src/users/user.entity.ts#User"],      // the subset only used in type positions
      "references": ["src/orders/orders.service.ts#OrdersService.createForUser"], // incoming
      "change": { "status": "modified", "hunks": [...], "signatureChanged": true, "previousSignature": "..." }
    }
  ],
  "pr": { "changedFiles": [...], "deletedFiles": [...], "deletedSymbols": [...], "renamedSymbols": {...} }, // overlay and merged
  "checks": { "danglingReferences": [...], "signatureChanges": [...], "newCycles": [...], "newFileCycles": [...], "affectedRoutes": [...], "tests": [...], "untested": [...] } // merged
}
```

- **Ids are stable across branches**: `<file>#<Class>.<member>`, `<file>#<function>`, or `<file>` for top-level code such as imports. Symbols can be matched between `main` and a PR this way.
- **Node kinds**: `file`, `class`, `method`, `constructor`, `function`, `variable`, `interface`, `type`, `enum`.
- **Modules**: a file belongs to the nearest directory containing a `*.module.ts`. Folders under the AppModule directory without a module of their own (such as `src/common`) become implicit groups with `declared: false`.
- **NestJS metadata**: `@Module` imports (including `forRoot`/`register` calls and `forwardRef`), custom providers (`provide`/`useClass`/`useFactory`/`useExisting`/`useValue`), constructor injection (`@Inject` tokens, `@InjectRepository`, `@Optional`), `@Controller` prefixes, route decorators and `app.setGlobalPrefix`. String and constant tokens are resolved to the class that provides them.
- `change` only appears in the overlay and the merged result. A modified node's `hunks` hold only the diff lines inside that node.

## Limitations

- Static analysis only: providers registered inside dynamic modules (`forRoot` bodies) are not traced into the module graph, and module ids come from the directory layout.
- Calls through interfaces resolve to the interface, not to the implementations.
- Without `--base-ref`, the working tree must match the head of the diff.
- Untracked files are not part of `git diff`. Commit or `git add -N` them before running `overlay` locally (`dyffle watch` includes them).
