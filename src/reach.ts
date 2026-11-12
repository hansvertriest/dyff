import type { AffectedRoute, Index, SymbolNode, TestedBy } from './schema.js';

/** What `reach` needs from an index, built once with `reachGraph` when walking from many nodes. */
export interface ReachGraph {
  byId: Map<string, SymbolNode>;
  /** `referrer|target` pairs where the reference is type-only. */
  typeOnly: Set<string>;
}

export interface ReachOptions {
  /** How many caller steps to follow. Default 8. */
  depth?: number;
  /** A graph from `reachGraph(index)`, to reuse across calls on the same index. */
  graph?: ReachGraph;
}

export interface Reach {
  /** Each route the node reaches, once, with `changed` set to the node and the shortest chain to the route. */
  routes: AffectedRoute[];
  /** Test files whose code reaches the node, sorted. */
  testFiles: string[];
  /** Test cases that reach the node, nearest first. */
  testCases: TestedBy[];
}

const byNearest = (a: TestedBy, b: TestedBy) => a.steps - b.steps || a.test.localeCompare(b.test);

export function reachGraph(index: Index): ReachGraph {
  return {
    byId: new Map(index.nodes.map((n) => [n.id, n])),
    typeOnly: new Set(index.nodes.flatMap((n) => (n.typeUses ?? []).map((t) => `${n.id}|${t}`))),
  };
}

/**
 * Walk a node's callers (changed or not) out to the routes, test files and test cases that reach it.
 * A type-only reference (annotation, generic, implements) is followed one step, from the
 * start node itself, and the search stops there: the referrer's runtime code does not run it.
 * The walk stops at a test case, and goes on through other code in test files (helpers).
 * Throws on an id that is not in the index, so "not found" never reads as "nothing reaches it".
 */
export function reach(index: Index, id: string, opts: ReachOptions = {}): Reach {
  const { byId, typeOnly } = opts.graph ?? reachGraph(index);
  if (!byId.has(id)) throw new Error(`Unknown node "${id}"`);
  const depth = opts.depth ?? 8;
  const prev = new Map<string, string | null>([[id, null]]);
  let frontier = [id];
  const viaType = new Set<string>();
  const routes: AffectedRoute[] = [];
  const testFiles = new Set<string>();
  const testCases: TestedBy[] = [];
  for (let d = 0; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const n = byId.get(cur)!;
      if (n.test) testFiles.add(n.file);
      if (n.kind === 'test' && d > 0) testCases.push({ test: cur, steps: d });
      if (n.test && (n.kind === 'test' || n.kind === 'file')) continue;
      if (n.route) {
        const chain: string[] = [];
        for (let c: string | null = cur; c; c = prev.get(c) ?? null) chain.unshift(c);
        routes.push({ routeId: cur, route: n.route, changed: id, chain });
      }
      if (viaType.has(cur)) continue;
      for (const r of n.references) {
        if (prev.has(r) || !byId.has(r)) continue;
        if (typeOnly.has(`${r}|${cur}`)) {
          if (d > 0) continue;
          viaType.add(r);
        }
        prev.set(r, cur);
        next.push(r);
      }
    }
    frontier = next;
  }
  return { routes, testFiles: [...testFiles].sort(), testCases: testCases.sort(byNearest) };
}

/**
 * The test cases that reach each node outside test files, nearest first: for every node at
 * once what `reach(index, id).testCases` gives for one. Walks forward from each test case
 * along `uses`, so it costs one walk per test rather than one per node.
 */
export function testedBy(index: Index, opts: ReachOptions = {}): Map<string, TestedBy[]> {
  const { byId, typeOnly } = opts.graph ?? reachGraph(index);
  const depth = opts.depth ?? 8;
  const out = new Map<string, TestedBy[]>();
  for (const t of index.nodes) {
    if (t.kind !== 'test') continue;
    // Shortest runtime distance from the test to each node, and the nodes it reaches.
    const best = new Map<string, number>();
    const record = (id: string, steps: number) => {
      if (!(best.get(id)! <= steps)) best.set(id, steps);
    };
    const seen = new Set<string>([t.id]);
    let frontier = [t.id];
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const u of byId.get(cur)!.uses) {
          const n = byId.get(u);
          if (!n || (n.test && (n.kind === 'test' || n.kind === 'file'))) continue;
          // A type-only reference counts from the test itself, one step, and is not followed.
          if (typeOnly.has(`${cur}|${u}`)) {
            if (cur === t.id && !n.test) record(u, 1);
            continue;
          }
          if (seen.has(u)) continue;
          seen.add(u);
          next.push(u);
          if (!n.test) record(u, d);
        }
      }
      frontier = next;
    }
    for (const [id, steps] of best) {
      let list = out.get(id);
      if (!list) out.set(id, (list = []));
      list.push({ test: t.id, steps });
    }
  }
  for (const list of out.values()) list.sort(byNearest);
  return out;
}
