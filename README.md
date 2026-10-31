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
- the template counts as a reference from the component to every component it renders (`<OrderRow>` or `<order-row>`) and every name it uses in bindings, events and `{{ }}`. A change to the template or styles marks the component as modified
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
| `--exclude <glob>` | Extra files to skip, repeatable (`node_modules`, `dist`, `build`, `coverage` and `.d.ts` are always skipped) |
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

In `dyffle serve` or a `dyffle html` page, hover any diff line and click **+** to comment on it. The summary lists your comments and has a box for an overall comment. Comments stay in your browser, per head commit, until you delete them.

**Download comments** saves a JSON file that is the body of GitHub's [create a review](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request) call (`commit_id`, `body`, `comments` with `path`/`line`/`side`), plus a `dyffle.context` list with each comment's line of code and symbol. Hand it to Claude to put on the PR, or post it yourself:

```sh
gh api repos/{owner}/{repo}/pulls/12/reviews --input dyffle-review-1a2b3c4.json
```

The file has no `event`, so GitHub creates a pending review that you submit from the PR page.

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
- Untracked files are not part of `git diff`. Commit or `git add -N` them before running `overlay` locally.
