import { mermaidModuleMap } from './mermaid.js';
import type { Index, Route } from './schema.js';

export interface ReportOptions {
  /** Most items per list. Default 25. */
  limit?: number;
  /** Include a Mermaid module map. */
  map?: boolean;
  /** Link to the interactive page. */
  link?: string;
  /** Heading of the report. */
  title?: string;
}

const short = (id: string) => (id.includes('#') ? id.slice(id.indexOf('#') + 1) : id);
const code = (s: string) => '`' + s.replace(/`/g, "'") + '`';

export function routeLabel(route: Route, globalPrefix?: string): string {
  if (route.type !== 'http') return `${route.verb} ${route.path}`;
  const path = globalPrefix ? '/' + [globalPrefix, route.fullPath ?? route.path].join('/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '') : route.fullPath;
  return `${route.verb} ${path}`;
}

/** Markdown summary of a merged index, meant for a PR comment. */
export function markdownReport(index: Index, opts: ReportOptions = {}): string {
  const c = index.checks;
  if (!c) throw new Error('The report needs a merged index (dyff merge or dyff pr).');
  const limit = opts.limit ?? 25;
  const byId = new Map(index.nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  const list = <T>(items: T[], fmt: (x: T) => string) => {
    for (const x of items.slice(0, limit)) out.push('- ' + fmt(x));
    if (items.length > limit) out.push(`- …and ${items.length - limit} more`);
    out.push('');
  };

  const s = c.summary;
  out.push(`## ${opts.title ?? 'dyff: PR map'}`, '');
  out.push(
    `${s.filesChanged} files changed (+${s.additions} −${s.deletions}) · symbols: ${s.symbols.added} added, ${s.symbols.modified} modified, ${s.symbols.removed} removed`,
    '',
  );
  if (opts.link) out.push(`**[Open the interactive PR map](${opts.link})**`, '');
  if (opts.map) {
    const map = mermaidModuleMap(index);
    if (map) out.push(map, '', '<sub>Colored: changed modules · dashed: modules that use changed code · solid arrows: <code>@Module</code> imports · dotted: file imports · blue: new in this PR · red: circular</sub>', '');
  }
  if (s.changedModules.length) out.push(`**Changed modules:** ${s.changedModules.map(code).join(', ')}`, '');
  if (s.affectedModules.length) out.push(`**Modules that use changed code:** ${s.affectedModules.map(code).join(', ')}`, '');

  if (c.danglingReferences.length) {
    out.push(`### ⚠️ This PR breaks ${c.danglingReferences.length} reference${c.danglingReferences.length === 1 ? '' : 's'} it didn't update`, '');
    list(c.danglingReferences, (d) => `${code(short(d.from))} in ${code(d.file)} still uses ${code(short(d.to))}${d.maybeRenamedTo ? ` (renamed to ${code(short(d.maybeRenamedTo))}?)` : ''}`);
  }
  const sigs = c.signatureChanges.filter((x) => x.callersOutsidePr.length);
  if (sigs.length) {
    out.push('### Signature changes with callers outside this PR', '');
    list(sigs, (x) => `${code(short(x.id))}: ${code(x.before ?? '')} → ${code(x.after ?? '')}. Check ${x.callersOutsidePr.map((r) => code(short(r))).join(', ')}`);
  }
  if (c.newCycles.length) {
    out.push('### 🔴 New circular module dependencies', '');
    list(c.newCycles, (cy) => cy.map(code).join(' ⇄ '));
  }
  if (c.newModuleDependencies.length) {
    out.push('### New module dependencies', '');
    list(c.newModuleDependencies, (e) => `${code(e.from)} → ${code(e.to)} (${e.via}${e.forwardRef ? ', forwardRef' : ''})`);
  }
  if (c.removedModuleDependencies.length) {
    out.push('### Removed module dependencies', '');
    list(c.removedModuleDependencies, (e) => `${code(e.from)} → ${code(e.to)} (${e.via})`);
  }
  if (c.affectedRoutes.length) {
    out.push('### Affected routes', '');
    list(c.affectedRoutes, (r) => `**${routeLabel(r.route, index.globalPrefix)}** via ${r.chain.map((id) => code(short(id))).join(' → ')}`);
  }

  const changed = index.nodes.filter((n) => n.change && n.kind !== 'file' && !n.test);
  const testFiles = new Set(index.files.filter((f) => f.change && f.test).map((f) => f.path));
  if (changed.length) {
    out.push('### Changed symbols', '');
    const mark = { added: '🟢', modified: '🟡', removed: '🔴' } as const;
    list(changed, (n) => {
      const refs = n.references.filter((r) => !byId.get(r)?.change).length;
      return `${mark[n.change!.status]} ${code(short(n.id))} (${n.kind}, ${n.change!.status})${n.route ? ' · ' + routeLabel(n.route, index.globalPrefix) : ''}${refs ? ` · ${refs} caller${refs === 1 ? '' : 's'} outside the PR` : ''}`;
    });
  }
  if (testFiles.size) {
    out.push('### Test files changed', '');
    list([...testFiles], code);
  }
  if (c.untested.length) {
    out.push('### Changed code no test reaches', '');
    list(c.untested, (id) => code(short(id)));
  }
  return out.join('\n').trimEnd() + '\n';
}

export const EMBED_START = '<!-- dyff:start -->';
export const EMBED_END = '<!-- dyff:end -->';

/**
 * Put `section` into `body` between dyff markers: replaces an earlier dyff
 * section, or appends one. Everything else in `body` is kept as is. Markers
 * only count on a line of their own, so a description can mention them.
 */
export function embedSection(body: string, section: string): string {
  const block = `${EMBED_START}\n${section.trim()}\n${EMBED_END}`;
  const start = /^<!-- dyff:start -->\r?$/m.exec(body);
  const end = start && /^<!-- dyff:end -->\r?$/m.exec(body.slice(start.index));
  if (start && end) return body.slice(0, start.index) + block + body.slice(start.index + end.index + EMBED_END.length);
  const rest = body.trimEnd();
  return (rest ? rest + '\n\n---\n\n' : '') + block + '\n';
}
