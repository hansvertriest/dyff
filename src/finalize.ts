import { resolveInjectionTokens } from './nest.js';
import type { Index, ModuleInfo } from './schema.js';

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const isModuleFile = (p: string) => /\.module\.[cm]?tsx?$/.test(p);

/**
 * Assigns each file to a module: the nearest directory with a *.module.ts.
 * Files below the AppModule directory but in a folder without a module of
 * their own (e.g. src/common) form an implicit folder group.
 */
export function moduleAssigner(paths: string[]) {
  const moduleDirs = new Map<string, string>(); // module id -> module file
  const dirToId = new Map<string, string>();
  for (const p of [...paths].sort()) {
    if (!isModuleFile(p)) continue;
    const d = dirOf(p);
    if (!dirToId.has(d)) {
      dirToId.set(d, d || '.');
      moduleDirs.set(d || '.', p);
    } else {
      // A second module file in the same directory gets its own id.
      const id = p.replace(/\.[cm]?tsx?$/, '');
      moduleDirs.set(id, p);
    }
  }
  const fileToModule = new Map<string, string>();
  for (const [id, f] of moduleDirs) fileToModule.set(f, id);

  const moduleOf = (path: string): string => {
    const own = fileToModule.get(path);
    if (own) return own;
    let d = dirOf(path);
    for (;;) {
      const id = dirToId.get(d);
      if (id !== undefined) {
        const mf = moduleDirs.get(id)!;
        if (/^app\.module\./.test(baseOf(mf)) && dirOf(path) !== d) {
          const rest = dirOf(path).slice(d ? d.length + 1 : 0);
          return (d ? d + '/' : '') + rest.split('/')[0];
        }
        return id;
      }
      if (!d) break;
      d = dirOf(d);
    }
    const segs = dirOf(path).split('/');
    if (segs[0] === 'src' && segs[1]) return 'src/' + segs[1];
    return dirOf(path) || '.';
  };
  return { moduleOf, moduleDirs, fileToModule };
}

const sortUniq = (xs: Iterable<string>) => [...new Set(xs)].sort();

/**
 * Recompute everything derived from the per-file data: module assignment,
 * implicit folder modules, module ids of @Module imports, string-token
 * injections and incoming `references`. Mutates and returns the index.
 * `allPaths` lists every file of the codebase, for indexes (like an overlay)
 * that only hold some of them.
 */
export function finalize(index: Index, allPaths: string[] = index.files.map((f) => f.path)): Index {
  const { moduleOf, fileToModule } = moduleAssigner(allPaths);
  for (const f of index.files) f.module = moduleOf(f.path);
  const nodeById = new Map(index.nodes.map((n) => [n.id, n]));
  for (const n of index.nodes) n.module = moduleOf(n.file);

  // Declared modules get their id from their file; implicit groups are added for the rest.
  const modules = new Map<string, ModuleInfo>();
  for (const m of index.modules) {
    if (!m.declared || !m.file) continue;
    const id = fileToModule.get(m.file) ?? moduleOf(m.file);
    if (!modules.has(id)) modules.set(id, { ...m, id });
  }
  for (const f of index.files) {
    if (modules.has(f.module)) continue;
    const prev = index.modules.find((m) => m.id === f.module && !m.declared);
    modules.set(f.module, {
      id: f.module,
      name: f.module === '.' ? 'Project files' : `${baseOf(f.module)} (folder)`,
      declared: false,
      imports: [],
      providers: [],
      controllers: [],
      exports: [],
      ...(prev?.change ? { change: prev.change } : {}),
    });
  }
  for (const m of modules.values()) {
    for (const im of m.imports) {
      const cls = im.classId ? nodeById.get(im.classId) : undefined;
      if (cls) im.module = moduleOf(cls.file);
      else delete im.module;
    }
  }
  index.modules = [...modules.values()].sort((a, b) => a.id.localeCompare(b.id));

  resolveInjectionTokens(index);

  // Incoming references.
  const refs = new Map<string, Set<string>>();
  const addRef = (to: string, from: string) => {
    if (to === from || !nodeById.has(to)) return;
    let s = refs.get(to);
    if (!s) refs.set(to, (s = new Set()));
    s.add(from);
  };
  for (const n of index.nodes) {
    n.uses = sortUniq(n.uses);
    for (const u of n.uses) addRef(u, n.id);
    for (const inj of n.injects ?? []) if (inj.target) addRef(inj.target, n.id);
  }
  for (const n of index.nodes) n.references = sortUniq(refs.get(n.id) ?? []);

  index.files.sort((a, b) => a.path.localeCompare(b.path));
  index.nodes.sort((a, b) => (a.file === b.file ? a.range[0] - b.range[0] || a.id.localeCompare(b.id) : a.file.localeCompare(b.file)));
  return index;
}
