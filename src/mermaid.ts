import { moduleEdges } from './merge.js';
import type { Index } from './schema.js';

export interface MermaidOptions {
  /** Most modules to draw; beyond this only changed and affected modules are kept. Default 30. */
  maxNodes?: number;
}

const label = (s: string) => s.replace(/"/g, '#quot;').replace(/[<>]/g, '');

/**
 * A Mermaid flowchart of the modules a PR changed plus their direct neighbors,
 * in the colors of the viewer. GitHub renders it in PR descriptions and comments.
 */
export function mermaidModuleMap(index: Index, opts: MermaidOptions = {}): string {
  const c = index.checks;
  if (!c) throw new Error('The module map needs a merged index (dyff merge or dyff pr).');
  const max = opts.maxNodes ?? 30;

  const stats = new Map<string, { adds: number; dels: number; statuses: Set<string> }>();
  for (const f of index.files) {
    if (!f.change || f.test) continue;
    let s = stats.get(f.module);
    if (!s) stats.set(f.module, (s = { adds: 0, dels: 0, statuses: new Set() }));
    s.adds += f.change.additions;
    s.dels += f.change.deletions;
    s.statuses.add(f.change.status);
  }
  const changed = new Set(stats.keys());
  const affected = new Set(c.summary.affectedModules.filter((m) => !changed.has(m)));
  const edges = moduleEdges(index);
  for (const e of c.removedModuleDependencies) edges.push({ ...e });

  let shown = new Set(changed);
  for (const e of edges) {
    if (changed.has(e.from)) shown.add(e.to);
    if (changed.has(e.to)) shown.add(e.from);
  }
  if (shown.size > max) shown = new Set([...changed, ...affected]);
  if (!shown.size) return '';

  const ids = new Map([...shown].sort().map((m, i) => [m, `m${i}`]));
  const name = new Map(index.modules.map((m) => [m.id, m.name]));
  const lines = ['```mermaid', 'flowchart LR'];
  for (const [m, id] of ids) {
    const s = stats.get(m);
    const sub = s ? `${m} · +${s.adds} −${s.dels}` : affected.has(m) ? `${m} · uses changed code` : m;
    const cls = !s
      ? affected.has(m)
        ? 'affected'
        : 'context'
      : [...s.statuses].every((x) => x === 'added')
        ? 'added'
        : [...s.statuses].every((x) => x === 'removed')
          ? 'removed'
          : 'modified';
    lines.push(`  ${id}["<b>${label(name.get(m) ?? m)}</b><br/>${label(sub)}"]:::${cls}`);
  }

  // One arrow per module pair that touches a changed module: solid for @Module imports, dotted for file imports only.
  const pairs = new Map<string, { from: string; to: string; module: boolean; forwardRef: boolean }>();
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || !(changed.has(e.from) || changed.has(e.to))) continue;
    const k = `${e.from}|${e.to}`;
    const p = pairs.get(k) ?? { from: e.from, to: e.to, module: false, forwardRef: false };
    p.module ||= e.via === 'module-import';
    p.forwardRef ||= !!e.forwardRef;
    pairs.set(k, p);
  }
  const isNew = new Set(c.newModuleDependencies.map((e) => `${e.from}|${e.to}`));
  const isRemoved = new Set(c.removedModuleDependencies.map((e) => `${e.from}|${e.to}`));
  const cycleOf = new Map<string, number>();
  c.cycles.forEach((cy, i) => cy.forEach((m) => cycleOf.set(m, i)));
  const newCycles = new Set(c.newCycles.map((cy) => cy.join('|')));
  const styles: string[] = [];
  [...pairs.values()].forEach((p, i) => {
    const k = `${p.from}|${p.to}`;
    const arrow = p.module ? '-->' : '-.->';
    lines.push(`  ${ids.get(p.from)} ${arrow}${p.forwardRef ? '|forwardRef|' : ''} ${ids.get(p.to)}`);
    if (isRemoved.has(k)) styles.push(`  linkStyle ${i} stroke:#B83A33,stroke-width:2px,stroke-dasharray:6 4`);
    else if (cycleOf.has(p.from) && cycleOf.get(p.from) === cycleOf.get(p.to)) {
      const isNewCycle = newCycles.has(c.cycles[cycleOf.get(p.from)!].join('|'));
      styles.push(`  linkStyle ${i} stroke:${isNewCycle ? '#B83A33' : '#7A3BB8'},stroke-width:${isNewCycle ? 2.5 : 1.8}px`);
    }
    else if (isNew.has(k)) styles.push(`  linkStyle ${i} stroke:#3B4FD8,stroke-width:2.5px`);
  });
  lines.push(
    ...styles,
    '  classDef modified fill:#F5E9D2,stroke:#9C5F08,color:#18202B',
    '  classDef added fill:#DCF2E5,stroke:#17804F,color:#18202B',
    '  classDef removed fill:#F8E0DD,stroke:#B83A33,color:#18202B',
    '  classDef affected fill:#F8FAFB,stroke:#3B4FD8,stroke-dasharray:5 4,color:#18202B',
    '  classDef context fill:#EEF2F5,stroke:#CBD3DC,color:#5A6574',
    '```',
  );
  return lines.join('\n');
}
