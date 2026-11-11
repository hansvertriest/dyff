# AGENTS.md

Guidance for agents (and people) changing dyffle. Read this before you touch the code. It describes how the project is put together and the rules that keep it that way.

## What dyffle is

A TypeScript library and CLI (`dyffle`) that indexes a NestJS or Vue codebase into a JSON graph of modules, files and symbols, overlays a diff on it, runs review checks on the result, and shows it in a single-page viewer. `README.md` is the user documentation. `nest-pr-map.html` and `nest-pr-map-handoff.txt` are the original prototype and its handoff. They are history: don't change them.

## Layout

```
src/            the library and the CLI (ESM, compiled to dist/ by tsc)
viewer/         index.html: the whole viewer, one file, no build step
test/           dyffle.test.mjs (node:test, runs against dist/) and fixtures/
.dyffle/        state of a running `dyffle watch` (ignores itself in git)
```

## Modules in `src/` and how they depend on each other

Every file has one concern. The layers below only import from the layers above them. Keep it that way, and never add an import cycle (dyffle finds circular file imports, so it would flag its own).

| Layer | File | Concern |
| --- | --- | --- |
| Format | `schema.ts` | The JSON format: types and `SCHEMA_VERSION` only, no logic. Every other module speaks in these types. |
| Primitives | `ast.ts` | Small helpers over the TypeScript AST (names, decorators, hashing). |
| | `diff.ts` | Unified diffs: parse, slice by line range, reverse-apply. Pure text, no git. |
| | `git.ts` | Every call to `git`. Nothing else spawns git. |
| Framework knowledge | `nest.ts` | NestJS: `@Module`, providers, injection, routes. |
| | `vue.ts` | Vue SFCs: blocks, template references, vue-router routes. |
| | `symbols.ts` | Collecting the symbol nodes of one source file. |
| Analysis | `analyzer.ts` | `Analyzer`: a loaded ts-morph program and per-file analysis (uses, type uses, imports). |
| | `finalize.ts` | Derived data on an index: module assignment, reverse references. |
| Indexing | `indexer.ts` | `buildBaseIndex` and `buildOverlay`. |
| | `merge.ts` | `merge` (overlay onto base, plus all review `checks`), `rebase` (merged → base of the next change), module and file edges, cycles. |
| Output | `report.ts`, `mermaid.ts` | Markdown report and Mermaid map of a merged index. |
| | `serve.ts` | The HTTP server for the viewer, and the `LiveSource` interface a live server implements. Knows nothing about git or indexing. |
| Live | `reviews.ts` | Reviews made in the viewer under `watch`: their format, validation, storage (`ReviewStore`) and the Markdown `dyffle comments` prints. |
| | `live.ts` | `LiveSession`: `dyffle watch`. Keeps a dyffle of the whole branch, one per commit and one of the uncommitted changes up to date. Implements `LiveSource`. |
| Entry points | `index.ts` | The public API: re-exports only, no code. |
| | `cli.ts` | Argument parsing and wiring. Thin: it calls library functions and holds no logic of its own. |

Rules that follow from this:

- **New behavior goes in the layer it belongs to**, not in the caller that happens to need it. A new git call goes in `git.ts`. A new derived check goes in `merge.ts`. Framework rules go in `nest.ts` or `vue.ts`.
- **`serve.ts` talks to live state only through `LiveSource`.** When the server needs something new from `watch`, add a method to the interface and implement it in `live.ts`.
- **`cli.ts` stays thin.** If a command needs more than a few lines of logic, that logic is a library function, exported from `index.ts`.
- **Anything a user of the package can call is exported from `index.ts`**, types included.
- **The JSON format is a contract.** Change `schema.ts` only additively. Ids (`<file>#<Class>.<member>`) stay stable across branches. A breaking change means a new `SCHEMA_VERSION`.

## The viewer

`viewer/index.html` is one self-contained file: inline CSS and JS, no dependencies, no build, no network beyond the server it came from. `dyffle html` embeds data into it (`window.DYFFLE_DATA` / `DYFFLE_LIST`), `serve` and `watch` serve it with `/index.json`, `/indexes.json` and, under `watch`, `/views.json`, `/events`, `/source.json` and `/review.json`.

- Its script is organized in sections headed `/* ---------- Name ---------- */`. Put new code in the section it belongs to, or start a new section. Features that only exist under `watch` check `watch` and live in their own sections.
- Style only with the CSS custom properties defined at the top (`--ink`, `--muted`, `--accent`, `--add`, `--del`, `--mod`, ...), so light and dark mode and the WCAG contrast work keep holding.
- It must keep working on phones (see `isMobile()` and the bottom sheet).

## Code style

- TypeScript `strict`, ESM with `.js` import suffixes, Node 18.17+, only the dependency we have (`ts-morph`). Don't add dependencies without asking.
- Plain functions and small classes. No frameworks, no DI, no global state outside `LiveSession`.
- Doc comments say **what something is or why it is so**, in one or two plain sentences (`/** The base index at the merge base with baseRef, from cache or built once. */`). Inline comments only for the non-obvious why.
- Writes that other processes read (`.dyffle/*`) go to `<file>.tmp` first and are renamed into place.
- Names follow the domain: an *index* (base, overlay, merged), a *dyffle* (a merged index shown in the viewer), a *review*, a *snapshot*.

## Tests

- `npm test` builds and runs `node --test test/*.test.mjs` against `dist/`. Run it after every change.
- Tests live in `test/dyffle.test.mjs`, one `describe` per feature, and use real git repositories made in a temp dir from `test/fixtures/` (`nest-app/base` → `pr`, `vue-app/base` → `pr`). Add to the fixtures rather than mocking.
- A new feature or a behavior change comes with a test in its `describe`.

## Documentation and releases

- `README.md` documents every user-facing command, option, file and JSON field. Update it in the same change as the code. Keep `HELP` in `cli.ts` in step with it.
- Commit messages are one sentence about the effect for the user, in the imperative ("Show a file as changed when only code inside it changed"). Releases are separate `Release x.y.z` commits that only bump `package.json`.
