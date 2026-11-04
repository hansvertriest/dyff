import { reach, reachGraph } from './reach.js';
import { routeLabel } from './report.js';
import type { ChangeStatus, Checks, DanglingReference, FileImport, Index, NodeKind, SignatureChange, SymbolNode } from './schema.js';

export interface QueryOptions {
  /** How many caller steps to follow for routes and tests. Default 8. */
  depth?: number;
}

/** A node a name could mean, when it matches several. */
export interface QueryCandidate {
  id: string;
  kind: NodeKind;
  file: string;
}

/** What one node is connected to and what the branch did to it. Ids and short labels only: no hunks. */
export interface NodeImpact {
  node: { id: string; kind: NodeKind; file: string; range: [number, number]; signature?: string };
  change: { status: ChangeStatus; signatureChanged: boolean; previousSignature?: string } | null;
  /** Nodes that refer to this one, split by whether the caller is changed too. */
  callers: { touched: string[]; untouched: string[] };
  /** What this node uses at runtime: `uses` minus `typeUses`. */
  calls: string[];
  /** Each route that reaches this node, as a label like `GET /users/:id` and the chain from this node to it. */
  routes: { route: string; chain: string[] }[];
  /** Test files whose code reaches this node. */
  tests: string[];
  /** Dangling references from or to this node. */
  broken: DanglingReference[];
  /**
   * A class's own impact, member by member. The class node alone says little: routes reach its
   * methods, and signature changes and broken references sit on them.
   */
  members?: NodeImpact[];
}

export interface FileImpact {
  file: {
    path: string;
    change: { status: ChangeStatus | 'renamed'; oldPath?: string; additions: number; deletions: number } | null;
    imports: FileImport[];
  };
  /** The file's top-level nodes: the file node first (imports, top-level code, a .vue template), then its symbols. */
  symbols: NodeImpact[];
}

export interface BranchSummary {
  danglingReferences: DanglingReference[];
  /** Only the signature changes with callers outside the branch. */
  signatureChanges: Omit<SignatureChange, 'callersInPr'>[];
  newModuleDependencies: Checks['newModuleDependencies'];
  newCycles: string[][];
  newFileCycles: string[][];
  untested: string[];
}

/** Tell the shapes apart with `in`: `'candidates' in r`, `'node' in r`, `'file' in r`, `'summary' in r`. */
export type QueryResult = { candidates: QueryCandidate[] } | NodeImpact | FileImpact | { summary: BranchSummary };

/** The part of an id after the file path: `Class.method`, `Class` or a function name. */
const qualifiedName = (id: string) => id.slice(id.indexOf('#') + 1);

/**
 * The impact of a node id, a `Class.method` / `Class` / function name, or a project-relative
 * file path. With no target, a summary of the branch from `index.checks`. A name that matches
 * several nodes gives `{ candidates }`. Throws when nothing matches, and on a summary of an index
 * without checks, so neither reads as "nothing is wrong".
 */
export function query(index: Index, target?: string, opts: QueryOptions = {}): QueryResult {
  if (target === undefined) return { summary: branchSummary(index) };

  const impact = impactOf(index, opts.depth);
  const file = index.files.find((f) => f.path === target);
  if (file) {
    const c = file.change;
    return {
      file: {
        path: file.path,
        change: c ? { status: c.status, ...(c.oldPath ? { oldPath: c.oldPath } : {}), additions: c.additions, deletions: c.deletions } : null,
        imports: file.imports,
      },
      symbols: index.nodes.filter((n) => n.file === target && !n.parent).map(impact),
    };
  }

  const exact = index.nodes.find((n) => n.id === target);
  if (exact) return impact(exact);
  const named = index.nodes.filter((n) => n.kind !== 'file' && (qualifiedName(n.id) === target || n.name === target));
  if (!named.length) throw new Error(`Nothing in the index matches "${target}"`);
  if (named.length === 1) return impact(named[0]);
  return { candidates: named.map((n) => ({ id: n.id, kind: n.kind, file: n.file })) };
}

function impactOf(index: Index, depth?: number): (n: SymbolNode) => NodeImpact {
  const graph = reachGraph(index);
  const members = new Map<string, SymbolNode[]>();
  for (const n of index.nodes) if (n.parent) members.set(n.parent, [...(members.get(n.parent) ?? []), n]);
  const dangling = index.checks?.danglingReferences ?? [];

  const impact = (n: SymbolNode): NodeImpact => {
    const { routes, testFiles } = reach(index, n.id, { depth, graph });
    const isTouched = (id: string) => !!graph.byId.get(id)?.change;
    const typeOnly = new Set(n.typeUses);
    const own = members.get(n.id);
    return {
      node: { id: n.id, kind: n.kind, file: n.file, range: n.range, ...(n.signature !== undefined ? { signature: n.signature } : {}) },
      change: n.change
        ? {
            status: n.change.status,
            signatureChanged: !!n.change.signatureChanged,
            ...(n.change.previousSignature !== undefined ? { previousSignature: n.change.previousSignature } : {}),
          }
        : null,
      callers: { touched: n.references.filter(isTouched), untouched: n.references.filter((r) => !isTouched(r)) },
      calls: n.uses.filter((u) => !typeOnly.has(u)),
      routes: routes.map((r) => ({ route: routeLabel(r.route, index.globalPrefix), chain: r.chain })),
      tests: testFiles,
      broken: dangling.filter((d) => d.from === n.id || d.to === n.id),
      ...(own ? { members: own.map(impact) } : {}),
    };
  };
  return impact;
}

function branchSummary(index: Index): BranchSummary {
  const c = index.checks;
  if (!c) throw new Error(`A branch summary needs a merged index, got a "${index.kind}" index`);
  return {
    danglingReferences: c.danglingReferences,
    signatureChanges: c.signatureChanges.filter((s) => s.callersOutsidePr.length).map(({ callersInPr: _inPr, ...s }) => s),
    newModuleDependencies: c.newModuleDependencies,
    newCycles: c.newCycles,
    newFileCycles: c.newFileCycles,
    untested: c.untested,
  };
}
