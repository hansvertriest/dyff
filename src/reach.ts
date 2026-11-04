import type { AffectedRoute, Index, SymbolNode } from './schema.js';

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
}

export function reachGraph(index: Index): ReachGraph {
  return {
    byId: new Map(index.nodes.map((n) => [n.id, n])),
    typeOnly: new Set(index.nodes.flatMap((n) => (n.typeUses ?? []).map((t) => `${n.id}|${t}`))),
  };
}

/**
 * Walk a node's callers (changed or not) out to the routes and test files that reach it.
 * A type-only reference (annotation, generic, implements) is followed one step, from the
 * start node itself, and the search stops there: the referrer's runtime code does not run it.
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
  for (let d = 0; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const n = byId.get(cur)!;
      if (n.test) {
        testFiles.add(n.file);
        continue;
      }
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
  return { routes, testFiles: [...testFiles].sort() };
}
