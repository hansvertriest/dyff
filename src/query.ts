import { reach, reachGraph } from './reach.js';
import { code, routeLabel } from './report.js';
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

/** Most items per list in `queryMarkdown`. The result itself always has them all. */
const LIMIT = 25;

const capped = (items: string[]) => (items.length > LIMIT ? [...items.slice(0, LIMIT), `…and ${items.length - LIMIT} more`] : items);
const section = (title: string, items: string[]) => [`**${title} (${items.length}):**`, ...capped(items).map((x) => '- ' + x)].join('\n');
const inline = (items: string[]) => capped(items).join(', ');
const brokenLine = (d: DanglingReference) => `${code(d.from)} still uses ${code(d.to)}${d.maybeRenamedTo ? ` (renamed to ${code(d.maybeRenamedTo)}?)` : ''}`;
const none = (empty: string[]) => (empty.length ? [`**None:** ${empty.join(', ')}.`] : []);

const whatItIs = ({ node: { kind, range, signature } }: NodeImpact) =>
  `${kind}, ${range[0] === range[1] ? `line ${range[0]}` : `lines ${range[0]}-${range[1]}`}${signature ? `: ${code(signature)}` : ''}`;

function changeLine(c: NonNullable<NodeImpact['change']>): string {
  const was = c.signatureChanged ? `, signature changed${c.previousSignature ? ` (was ${code(c.previousSignature)})` : ''}` : '';
  return `**Change:** ${c.status}${was}`;
}

/** The lists of one node, callers with untouched first. `empty` names them in a "none" line; an empty name stays out of it. */
function lists(n: NodeImpact): { title: string; empty: string; items: string[] }[] {
  const { touched, untouched } = n.callers;
  return [
    { title: 'Callers, untouched', empty: touched.length ? 'untouched callers' : 'callers', items: untouched.map(code) },
    { title: 'Callers, touched too', empty: '', items: touched.map(code) },
    { title: 'Routes', empty: 'routes', items: n.routes.map((r) => `**${r.route}** via ${r.chain.map((id) => code(qualifiedName(id))).join(' → ')}`) },
    { title: 'Tests', empty: 'tests', items: n.tests.map(code) },
    { title: 'Broken references', empty: 'broken references', items: n.broken.map(brokenLine) },
  ];
}

const filled = (n: NodeImpact) => lists(n).filter((l) => l.items.length);
const isQuiet = (n: NodeImpact): boolean => !n.change && !filled(n).length && (n.members ?? []).every(isQuiet);

/** Symbols under a class or file, a few lines each: only what they have, and those with nothing named once, on one line. */
function nested(list: NodeImpact[], level: number): string[] {
  const quiet = list.filter(isQuiet);
  return [
    ...list.filter((n) => !isQuiet(n)).flatMap((n) => [
      `${'#'.repeat(level)} ${code(qualifiedName(n.node.id))}`,
      [whatItIs(n), ...(n.change ? [changeLine(n.change)] : []), ...filled(n).map((l) => `**${l.title} (${l.items.length}):** ${inline(l.items)}`)].map((x) => '- ' + x).join('\n'),
      ...nested(n.members ?? [], level + 1),
    ]),
    ...(quiet.length ? [`**No change or connections:** ${inline(quiet.map((n) => code(qualifiedName(n.node.id))))}`] : []),
  ];
}

function nodeMarkdown(n: NodeImpact): string[] {
  const head = [`## ${code(n.node.id)}`, whatItIs(n), ...(n.change ? [changeLine(n.change)] : []), ...filled(n).map((l) => section(l.title, l.items))];
  // The class node alone can have no routes while its methods do, so a "none" here would mislead.
  if (n.members?.length) return [...head, 'Empty sections are left out.', ...nested(n.members, 3)];
  const empty = lists(n).filter((l) => l.empty && !l.items.length).map((l) => l.empty);
  return [...head, ...none([...(n.change ? [] : ['change']), ...empty])];
}

function fileMarkdown({ file, symbols }: FileImpact): string[] {
  const c = file.change;
  const own = symbols.find((n) => n.node.kind === 'file');
  return [
    `## ${code(file.path)}`,
    `**Change:** ${c ? `${c.status}${c.oldPath ? ` from ${code(c.oldPath)}` : ''}, +${c.additions} −${c.deletions}` : 'none'}`,
    ...(file.imports.length ? [`**Imports:** ${inline(file.imports.map((i) => code(i.resolved ?? i.spec)))}`] : []),
    ...(own ? filled(own).map((l) => section(l.title, l.items)) : []),
    'Empty sections are left out.',
    ...nested(symbols.filter((n) => n !== own), 3),
  ];
}

function summaryMarkdown(s: BranchSummary): string[] {
  const lists: [string, string[]][] = [
    ['Broken references', s.danglingReferences.map(brokenLine)],
    [
      'Signature changes with callers outside the branch',
      s.signatureChanges.map((x) => `${code(x.id)}: ${code(x.before ?? '')} → ${code(x.after ?? '')}. Check ${inline(x.callersOutsidePr.map(code))}`),
    ],
    ['New module dependencies', s.newModuleDependencies.map((e) => `${code(e.from)} → ${code(e.to)} (${e.via}${e.forwardRef ? ', forwardRef' : ''})`)],
    ['New module cycles', s.newCycles.map((cy) => cy.map(code).join(' ⇄ '))],
    ['New file cycles', s.newFileCycles.map((cy) => cy.map(code).join(' ⇄ '))],
    ['Changed code no test reaches', s.untested.map(code)],
  ];
  return [
    '## Branch summary',
    ...lists.filter(([, items]) => items.length).map(([title, items]) => section(title, items)),
    ...none(lists.filter(([, items]) => !items.length).map(([title]) => title.toLowerCase())),
  ];
}

/** A `QueryResult` as short Markdown for an agent. Long lists stop at 25 items and say how many are left. */
export function queryMarkdown(result: QueryResult): string {
  const blocks =
    'candidates' in result
      ? [section('Several nodes match, query one by id', result.candidates.map((c) => `${code(c.id)} (${c.kind})`))]
      : 'summary' in result
        ? summaryMarkdown(result.summary)
        : 'file' in result
          ? fileMarkdown(result)
          : nodeMarkdown(result);
  return blocks.join('\n\n') + '\n';
}
