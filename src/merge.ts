import { finalize } from './finalize.js';
import type { AffectedRoute, Checks, DanglingReference, Index, ModuleEdge, SignatureChange, SymbolNode, TestReach } from './schema.js';

export interface MergeOptions {
  /** How many caller steps to follow for routes and tests. Default 8. */
  depth?: number;
}

const clone = <T>(x: T): T => structuredClone(x);

/**
 * Swap a PR overlay into a base index: files the PR touched are replaced by
 * their overlay version, removed symbols are kept with change.status "removed",
 * and everything derived (modules, references) is recomputed. The result
 * carries `checks` for review.
 */
export function merge(base: Index, overlay: Index, opts: MergeOptions = {}): Index {
  if (base.kind !== 'base') throw new Error(`Expected a base index, got "${base.kind}"`);
  if (overlay.kind !== 'overlay' || !overlay.pr) throw new Error(`Expected a PR overlay, got "${overlay.kind}"`);
  const pr = overlay.pr;
  const touched = new Set([...pr.changedFiles, ...pr.deletedFiles, ...pr.renamedFiles.map((r) => r.from)]);
  const remap = (id: string) => pr.renamedSymbols[id] ?? id;

  const merged: Index = {
    ...clone(overlay),
    kind: 'merged',
    generatedAt: new Date().toISOString(),
    globalPrefix: overlay.globalPrefix ?? base.globalPrefix,
    files: [
      ...base.files.filter((f) => !touched.has(f.path)).map(({ change: _c, ...f }) => clone(f)),
      ...clone(overlay.files),
    ],
    nodes: [
      ...base.nodes
        .filter((n) => !touched.has(n.file))
        .map(({ change: _c, ...n }) => {
          const c = clone(n);
          c.uses = c.uses.map(remap);
          if (c.typeUses) c.typeUses = c.typeUses.map(remap);
          for (const inj of c.injects ?? []) if (inj.target) inj.target = remap(inj.target);
          return c;
        }),
      ...clone(overlay.nodes),
      ...clone(pr.deletedSymbols),
    ],
    modules: [
      ...base.modules.filter((m) => m.declared && m.file && !touched.has(m.file)).map(({ change: _c, ...m }) => clone(m)),
      ...base.modules
        .filter((m) => m.declared && m.file && pr.deletedFiles.includes(m.file))
        .map((m) => ({ ...clone(m), change: { status: 'removed' as const } })),
      ...clone(overlay.modules.filter((m) => m.declared)),
    ],
  };
  if (merged.globalPrefix === undefined) delete merged.globalPrefix;
  // Keep each changed file's base-side imports, so a viewer can tell which file links the PR added or removed.
  const baseFiles = new Map(base.files.map((f) => [f.path, f]));
  const renamedFile = new Map(pr.renamedFiles.map((r) => [r.from, r.to]));
  for (const f of merged.files) {
    if (!f.change) continue;
    const old = baseFiles.get(f.change.oldPath ?? f.path);
    if (!old) continue;
    f.change.previousImports = clone(old.imports).map((im) => (im.resolved ? { ...im, resolved: renamedFile.get(im.resolved) ?? im.resolved } : im));
  }
  for (const m of merged.modules)
    for (const im of m.imports) if (im.classId) im.classId = remap(im.classId);
  finalize(merged);
  merged.checks = runChecks(base, merged, touched, opts.depth ?? 8);
  return merged;
}

/** Module dependency edges: @Module imports and plain file imports that cross modules. */
export function moduleEdges(index: Index): ModuleEdge[] {
  const removed = new Set(index.modules.filter((m) => m.change?.status === 'removed').map((m) => m.id));
  const fileModule = new Map(index.files.filter((f) => f.change?.status !== 'removed').map((f) => [f.path, f.module]));
  const edges = new Map<string, ModuleEdge>();
  const add = (e: ModuleEdge) => {
    if (e.from === e.to || removed.has(e.from) || removed.has(e.to)) return;
    const k = `${e.from}|${e.to}|${e.via}`;
    const prev = edges.get(k);
    if (!prev) edges.set(k, e);
    else if (e.forwardRef) prev.forwardRef = true;
  };
  for (const m of index.modules)
    for (const im of m.imports)
      if (im.module) add({ from: m.id, to: im.module, via: 'module-import', ...(im.forwardRef ? { forwardRef: true } : {}) });
  for (const f of index.files) {
    if (f.change?.status === 'removed' || f.test) continue;
    for (const im of f.imports) {
      if (im.typeOnly || !im.resolved) continue;
      const to = fileModule.get(im.resolved);
      if (to) add({ from: f.module, to, via: 'file-import' });
    }
  }
  return [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.via.localeCompare(b.via));
}

/** Runtime imports between files: type-only imports, tests and removed files left out. */
export function fileEdges(index: Index): { from: string; to: string }[] {
  const live = new Set(index.files.filter((f) => f.change?.status !== 'removed' && !f.test).map((f) => f.path));
  const edges = new Map<string, { from: string; to: string }>();
  for (const f of index.files) {
    if (!live.has(f.path)) continue;
    for (const im of f.imports)
      if (!im.typeOnly && im.resolved && im.resolved !== f.path && live.has(im.resolved)) edges.set(`${f.path}|${im.resolved}`, { from: f.path, to: im.resolved });
  }
  return [...edges.values()];
}

/** Strongly connected components with more than one member (Tarjan): modules, or files. */
export function findCycles(edges: { from: string; to: string }[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from)!.push(e.to);
  }
  let idx = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const strong = (v: string) => {
    index.set(v, idx);
    low.set(v, idx++);
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v)!) {
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) out.push(comp.sort());
    }
  };
  for (const v of [...adj.keys()].sort()) if (!index.has(v)) strong(v);
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

const CODE_KINDS = new Set(['class', 'method', 'constructor', 'function', 'variable']);

function runChecks(base: Index, merged: Index, touched: Set<string>, depth: number): Checks {
  const byId = new Map(merged.nodes.map((n) => [n.id, n]));
  const inPr = (id: string) => touched.has(byId.get(id)?.file ?? '');
  const changed = merged.nodes.filter((n) => n.change);

  // Dangling references: unchanged code pointing at symbols the PR removed. A target that was never
  // indexed (a .json import, say) is not one: it is missing on the base side too.
  const baseIds = new Set(base.nodes.map((n) => n.id));
  const dangling: DanglingReference[] = [];
  const renameGuess = (gone: SymbolNode): string | undefined => {
    const cands = merged.nodes.filter(
      (n) => n.change?.status === 'added' && n.kind === gone.kind && n.file === gone.file && n.parent === gone.parent,
    );
    return cands.length === 1 ? cands[0].id : undefined;
  };
  for (const n of merged.nodes) {
    if (touched.has(n.file)) continue;
    const targets = new Set([...n.uses, ...(n.injects ?? []).map((i) => i.target).filter((t): t is string => !!t)]);
    for (const to of targets) {
      const t = byId.get(to);
      if (t ? t.change?.status !== 'removed' : !baseIds.has(to)) continue;
      const guess = t ? renameGuess(t) : undefined;
      dangling.push({ from: n.id, to, file: n.file, ...(guess ? { maybeRenamedTo: guess } : {}) });
    }
  }

  const signatureChanges: SignatureChange[] = changed
    .filter((n) => n.change?.signatureChanged)
    .map((n) => ({
      id: n.id,
      before: n.change!.previousSignature,
      after: n.signature,
      callersOutsidePr: n.references.filter((r) => !inPr(r)),
      callersInPr: n.references.filter(inPr),
    }));

  const baseEdges = moduleEdges(base);
  const mergedEdges = moduleEdges(merged);
  const key = (e: ModuleEdge) => `${e.from}|${e.to}|${e.via}`;
  const baseKeys = new Set(baseEdges.map(key));
  const mergedKeys = new Set(mergedEdges.map(key));
  // A cycle is new when its modules were not already one cycle on the base side. Matching the exact
  // member list would flag an existing cycle as new whenever the PR adds or removes one of its modules.
  const baseCycleOf = new Map<string, number>();
  findCycles(baseEdges).forEach((c, i) => c.forEach((m) => baseCycleOf.set(m, i)));
  const cycles = findCycles(mergedEdges);
  const isNewCycle = (c: string[]) => !baseCycleOf.has(c[0]) || c.some((m) => baseCycleOf.get(m) !== baseCycleOf.get(c[0]));
  // The same for circular file imports, with a renamed file matched to its base path.
  const baseFileCycleOf = new Map<string, number>();
  findCycles(fileEdges(base)).forEach((c, i) => c.forEach((f) => baseFileCycleOf.set(f, i)));
  const basePath = new Map(merged.files.map((f) => [f.path, f.change?.status === 'added' ? null : (f.change?.oldPath ?? f.path)]));
  const fileCycles = findCycles(fileEdges(merged));
  const isNewFileCycle = (c: string[]) => {
    const ids = c.map((f) => { const b = basePath.get(f); return b ? baseFileCycleOf.get(b) : undefined; });
    return ids[0] === undefined || ids.some((i) => i !== ids[0]);
  };

  // Seeds: the most specific changed symbols (a class only counts when none of its members changed).
  // A .vue file counts too: its file-level code includes the template.
  const changedParents = new Set(changed.map((n) => n.parent).filter(Boolean));
  const seeds = changed.filter(
    (n) => (n.kind !== 'file' || n.file.endsWith('.vue')) && !n.test && !(n.kind === 'class' && changedParents.has(n.id)),
  );

  // A type-only reference (annotation, generic, implements) is followed one step, from the
  // changed symbol itself, and the search stops there: the referrer's runtime code is unchanged.
  const typeOnly = new Set(merged.nodes.flatMap((n) => (n.typeUses ?? []).map((t) => `${n.id}|${t}`)));
  const affected = new Map<string, AffectedRoute>();
  const tests: TestReach[] = [];
  const untested: string[] = [];
  for (const seed of seeds) {
    const prev = new Map<string, string | null>([[seed.id, null]]);
    let frontier = [seed.id];
    const viaType = new Set<string>();
    const testFiles = new Set<string>();
    for (let d = 0; d <= depth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        const n = byId.get(id)!;
        if (n.test) {
          testFiles.add(n.file);
          continue;
        }
        if (n.route) {
          const chain: string[] = [];
          for (let c: string | null = id; c; c = prev.get(c) ?? null) chain.unshift(c);
          const existing = affected.get(id);
          if (!existing || existing.chain.length > chain.length) affected.set(id, { routeId: id, route: n.route, changed: seed.id, chain });
        }
        if (viaType.has(id)) continue;
        for (const r of n.references) {
          if (prev.has(r) || !byId.has(r)) continue;
          if (typeOnly.has(`${r}|${id}`)) {
            if (d > 0) continue;
            viaType.add(r);
          }
          prev.set(r, id);
          next.push(r);
        }
      }
      frontier = next;
    }
    if (!CODE_KINDS.has(seed.kind) || seed.change?.status === 'removed') continue;
    tests.push({ id: seed.id, testFiles: [...testFiles].sort() });
    if (!testFiles.size) untested.push(seed.id);
  }

  const changedModules = new Set<string>();
  for (const f of merged.files) if (f.change) changedModules.add(f.module);
  const affectedModules = new Set<string>();
  for (const s of seeds) for (const r of s.references) affectedModules.add(byId.get(r)!.module);
  for (const e of mergedEdges) if (changedModules.has(e.to)) affectedModules.add(e.from);
  for (const m of changedModules) affectedModules.delete(m);

  const symbols = { added: 0, modified: 0, removed: 0 };
  for (const n of changed) if (n.kind !== 'file') symbols[n.change!.status]++;
  let additions = 0;
  let deletions = 0;
  for (const f of merged.files) {
    additions += f.change?.additions ?? 0;
    deletions += f.change?.deletions ?? 0;
  }
  for (const f of merged.pr?.unindexedFiles ?? []) {
    additions += f.additions;
    deletions += f.deletions;
  }

  return {
    danglingReferences: dangling,
    signatureChanges,
    newModuleDependencies: mergedEdges.filter((e) => !baseKeys.has(key(e))),
    removedModuleDependencies: baseEdges.filter((e) => !mergedKeys.has(key(e))),
    newCycles: cycles.filter(isNewCycle),
    cycles,
    newFileCycles: fileCycles.filter(isNewFileCycle),
    fileCycles,
    affectedRoutes: [...affected.values()].sort((a, b) => (a.route.fullPath ?? a.route.path).localeCompare(b.route.fullPath ?? b.route.path)),
    tests,
    untested,
    summary: {
      filesChanged: merged.pr?.changedFiles.length ?? 0,
      additions,
      deletions,
      symbols,
      changedModules: [...changedModules].sort(),
      affectedModules: [...affectedModules].sort(),
    },
  };
}
