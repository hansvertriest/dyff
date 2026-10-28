# dyff

Turn a NestJS codebase into a JSON graph of modules, files, classes and functions, with each one linked to the exact places it is referenced. Then overlay a pull request on that graph to see what the PR really touches.

For a PR, dyff reports:

- every changed symbol (added / modified / removed), with its own slice of the diff
- **references the PR breaks**: unchanged code that still calls a symbol the PR removed or renamed
- **signature changes** and the callers outside the PR that should be checked
- **new module dependencies** and **new circular dependencies** (including `forwardRef`)
- **affected routes**: callers are followed upward to HTTP routes, message patterns, GraphQL resolvers, cron jobs and event handlers, e.g. `findOne → OrdersService.createForUser → OrdersController.create → POST /orders/:userId`
- **test reach**: which spec files reach each changed symbol, and which changed code no test reaches

The analysis uses the TypeScript compiler (via [ts-morph](https://ts-morph.com)), so references are exact: two methods both named `create` are never confused, and path aliases and barrel files are resolved.

## Install

```sh
npm install --save-dev dyff
```

Requires Node 18.17+ and git (for `--base-ref`).

## How it works

dyff works in two layers:

1. **Base index**: the whole codebase on `main`, indexed once (e.g. in CI on every merge) and cached.
2. **PR overlay**: only the files the PR changed. The whole PR branch is loaded so the type checker can resolve references, but only the changed files are walked. Each changed file is re-indexed in full and compared with its base version, so every symbol gets a `change` status.

`merge` swaps the overlay into the base index. References from unchanged files come from the base index (they are identical to `main`), and the checks run against the merged graph.

## CLI

```sh
# On main: index the whole codebase
dyff index -o base.json

# On the PR branch: index the changed files (diff from the merge base with origin/main)
dyff overlay --base-ref origin/main -o overlay.json

# Merge, run the checks, and write a Markdown summary
dyff merge base.json overlay.json -o merged.json
dyff report merged.json -o report.md

# Or overlay + merge + report in one step
dyff pr --base base.json --base-ref origin/main -o merged.json --report report.md
```

Instead of `--base-ref` you can pass a diff: `--diff pr.diff`, or `--diff -` for stdin (for example `gh pr diff 123 | dyff overlay --diff -`). The working tree must be the PR's head, and diff paths must be relative to `--root`. dyff rebuilds the base version of each changed file by reverse-applying the diff.

| Option | |
| --- | --- |
| `--root <dir>` | Directory node ids are relative to (default: current directory) |
| `--tsconfig <file>` | Compiler options and path aliases (default: `<root>/tsconfig.json`) |
| `--include <glob>` | Files to index, repeatable (default: all `.ts` files under root) |
| `--exclude <glob>` | Extra files to skip, repeatable (`node_modules`, `dist`, `build`, `coverage` and `.d.ts` are always skipped) |
| `--depth <n>` | How many caller steps to follow for routes and tests (default 8) |
| `-o, --out <file>` | Write to a file instead of stdout |
| `--pretty` | Indented JSON |
| `-q, --quiet` | No progress output on stderr |

### In CI (GitHub Actions)

```yaml
# On push to main: build and cache the base index
- run: npx dyff index -o base.json
- uses: actions/upload-artifact@v4
  with: { name: dyff-base, path: base.json }

# On pull_request: overlay the PR and post the report
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: dawidd6/action-download-artifact@v6
  with: { name: dyff-base, branch: main, workflow: <your-base-workflow>.yml }
- run: npx dyff pr --base base.json --base-ref origin/${{ github.base_ref }} -o merged.json --report report.md
- run: gh pr comment ${{ github.event.number }} --body-file report.md --edit-last || gh pr comment ${{ github.event.number }} --body-file report.md
  env: { GH_TOKEN: ${{ github.token }} }
```

## API

```ts
import { buildBaseIndex, buildOverlay, merge, markdownReport } from 'dyff';

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
  "checks": { "danglingReferences": [...], "signatureChanges": [...], "newCycles": [...], "affectedRoutes": [...], "tests": [...], "untested": [...] } // merged
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
