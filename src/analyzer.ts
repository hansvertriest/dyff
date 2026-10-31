import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { Project, ts, type SourceFile } from 'ts-morph';
import { findGlobalPrefix, nestInjections, nestModule, type Resolver } from './nest.js';
import type { FileImport, FileInfo, ModuleInfo, SymbolNode } from './schema.js';
import { collectFile, isTestFile, type FileSymbols } from './symbols.js';
import { isVueFile, vueToTs } from './vue.js';

export interface ProjectOptions {
  /** Directory node ids are relative to. Defaults to the current directory. */
  root?: string;
  /** tsconfig.json used for compiler options and path aliases. Defaults to <root>/tsconfig.json when present. */
  tsconfig?: string;
  /** Globs (relative to root) of files to index. */
  include?: string[];
  exclude?: string[];
}

export const DEFAULT_INCLUDE = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts', '**/*.vue'];
export const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/*.d.ts'];

/** True when an identifier only appears in a type (annotation, `implements`, generic argument, ...). */
function inTypePosition(id: ts.Node): boolean {
  for (let p = id.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isExpressionWithTypeArguments(p) && ts.isHeritageClause(p.parent)) return p.parent.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(p.parent.parent);
    if (ts.isTypeNode(p)) return true;
    if (ts.isBlock(p) || ts.isClassLike(p)) return false;
  }
  return false;
}

export interface FileAnalysis {
  path: string;
  nodes: Omit<SymbolNode, 'module' | 'references'>[];
  info: Omit<FileInfo, 'module'>;
  modules: Omit<ModuleInfo, 'id'>[];
  globalPrefix?: string;
}

/** A loaded TypeScript program plus helpers to analyze its files. */
export class Analyzer {
  readonly root: string;
  readonly project: Project;
  private readonly checker: ts.TypeChecker;
  private readonly resolver: Resolver = { targetOf: (n) => this.targetOf(n), resolveSymbol: (n) => this.resolveSymbol(n) };
  private readonly symbolCache = new Map<string, FileSymbols>();
  /** Absolute path of a .vue file's TypeScript view -> project-relative path of the .vue file. */
  private readonly vueViews = new Map<string, string>();
  /** Project-relative .vue path -> absolute path of its TypeScript view and the original text. */
  private readonly vueFiles = new Map<string, { view: string; text: string }>();

  constructor(opts: ProjectOptions = {}) {
    this.root = resolve(opts.root ?? process.cwd());
    const tsconfig = opts.tsconfig ? resolve(opts.tsconfig) : appTsconfig(resolve(this.root, 'tsconfig.json'));
    this.project = new Project({
      ...(existsSync(tsconfig) ? { tsConfigFilePath: tsconfig } : { compilerOptions: { experimentalDecorators: true, allowJs: false } }),
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: false,
    });
    const include = opts.include?.length ? opts.include : DEFAULT_INCLUDE;
    const exclude = [...DEFAULT_EXCLUDE, ...(opts.exclude ?? [])];
    const paths = this.project.getFileSystem().globSync([
      ...include.map((g) => resolve(this.root, g)),
      ...exclude.map((g) => '!' + resolve(this.root, g)),
    ]);
    for (const abs of paths) {
      if (!isVueFile(abs)) {
        this.project.addSourceFileAtPath(abs);
        continue;
      }
      // TypeScript resolves `./X.vue` to `./X.vue.ts`, so imports of components find their view.
      const text = readFileSync(abs, 'utf8');
      const { ext, code } = vueToTs(text);
      const view = abs + ext;
      this.project.createSourceFile(view, code, { overwrite: true });
      const rel = this.rel(abs);
      if (!rel) continue;
      this.vueViews.set(view, rel);
      this.vueFiles.set(rel, { view, text });
    }
    this.checker = this.project.getTypeChecker().compilerObject;
  }

  /** Project-relative posix path, or undefined for files outside the root or in node_modules. */
  rel(abs: string): string | undefined {
    const vue = this.vueViews.get(abs);
    if (vue) return vue;
    const r = relative(this.root, abs);
    if (!r || r.startsWith('..') || r.includes('node_modules')) return undefined;
    return r.split(sep).join('/');
  }

  /** Indexed source files, project-relative paths. */
  sourcePaths(): string[] {
    return this.project
      .getSourceFiles()
      .filter((sf) => !sf.isDeclarationFile() && !sf.isInNodeModules())
      .map((sf) => this.rel(sf.getFilePath()))
      .filter((p): p is string => !!p)
      .sort();
  }

  sourceFile(path: string): SourceFile | undefined {
    return this.project.getSourceFile(this.vueFiles.get(path)?.view ?? resolve(this.root, path));
  }

  /** Source text of a project file as it is on disk (for a .vue file, not its TypeScript view). */
  text(path: string): string | undefined {
    return this.vueFiles.get(path)?.text ?? this.sourceFile(path)?.getFullText();
  }

  private symbols(sf: ts.SourceFile): FileSymbols | undefined {
    const path = this.rel(sf.fileName);
    if (!path || sf.isDeclarationFile) return undefined;
    let s = this.symbolCache.get(path);
    if (!s) {
      s = collectFile(sf, path);
      this.symbolCache.set(path, s);
    }
    return s;
  }

  /** Node id for a declaration, walking up from members that are not nodes themselves. */
  private idForDecl(decl: ts.Node): string | undefined {
    const fs = this.symbols(decl.getSourceFile());
    if (!fs) return undefined;
    let n: ts.Node | undefined = decl;
    if (ts.isVariableDeclaration(n) && fs.byDecl.has(n)) return fs.byDecl.get(n);
    // `export default { ... }` (e.g. a Vue component's options) stands for the file.
    if (ts.isExportAssignment(n) && ts.isSourceFile(n.parent)) return fs.byDecl.get(n.parent);
    while (n) {
      const id = fs.byDecl.get(n);
      if (id) return id;
      if (
        ts.isEnumMember(n) ||
        ts.isPropertySignature(n) ||
        ts.isMethodSignature(n) ||
        ts.isPropertyDeclaration(n) ||
        ts.isIndexSignatureDeclaration(n) ||
        (ts.isParameter(n) && ts.isParameterPropertyDeclaration(n, n.parent))
      ) {
        n = ts.isParameter(n) ? n.parent.parent : n.parent;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  private resolveSymbol(node: ts.Node): ts.Symbol | undefined {
    let sym = this.checker.getSymbolAtLocation(node);
    if (sym && sym.flags & ts.SymbolFlags.Alias) {
      try {
        sym = this.checker.getAliasedSymbol(sym);
      } catch {
        /* unresolved alias */
      }
    }
    return sym;
  }

  /** Node ids an expression (identifier, property access) refers to. */
  private targetsOf(node: ts.Node): string[] {
    const sym = this.resolveSymbol(node);
    if (!sym) return [];
    const ids = new Set<string>();
    for (const d of sym.getDeclarations() ?? []) {
      const id = this.idForDecl(d);
      if (id) ids.add(id);
    }
    return [...ids];
  }

  private targetOf(node: ts.Node): string | undefined {
    return this.targetsOf(node)[0];
  }

  /** Full analysis of one file: nodes with exact outgoing references, Nest metadata and imports. */
  analyzeFile(path: string): FileAnalysis {
    const msf = this.sourceFile(path);
    if (!msf) throw new Error(`File is not part of the project: ${path}`);
    const sf = msf.compilerNode;
    const fs = this.symbols(sf)!;
    const uses = new Map<string, Set<string>>(fs.nodes.map((n) => [n.id, new Set<string>()]));

    const enclosing = (n: ts.Node): string => {
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        const id = fs.byDecl.get(p);
        if (id) return id;
      }
      return path;
    };
    const isMemberOf = (child: string, parent: string) => child.startsWith(parent + '.');
    const valueUses = new Set<string>();

    const visit = (n: ts.Node) => {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isImportEqualsDeclaration(n)) return;
      const lazy = ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0];
      if (lazy && ts.isStringLiteralLike(lazy)) {
        // `import('./x')` refers to the module it loads, e.g. a lazily loaded route component.
        const from = enclosing(n);
        for (const to of this.targetsOf(lazy)) {
          if (to === from) continue;
          uses.get(from)?.add(to);
          valueUses.add(`${from}|${to}`);
        }
      } else if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) {
        const parent = n.parent as ts.Node & { name?: ts.Node };
        const isDeclName = parent && parent.name === n && fs.byDecl.has(parent);
        if (!isDeclName) {
          const from = enclosing(n);
          const typeOnly = inTypePosition(n);
          for (const to of this.targetsOf(n)) {
            if (to === from || isMemberOf(from, to) || isMemberOf(to, from)) continue;
            uses.get(from)?.add(to);
            if (!typeOnly) valueUses.add(`${from}|${to}`);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);

    const modules: Omit<ModuleInfo, 'id'>[] = [];
    const nodes = fs.nodes.map(({ decl, ...n }) => {
      const out: Omit<SymbolNode, 'module' | 'references'> = { ...n, uses: [...(uses.get(n.id) ?? [])].sort() };
      const typeUses = out.uses.filter((to) => !valueUses.has(`${n.id}|${to}`));
      if (typeUses.length) out.typeUses = typeUses;
      if (n.kind === 'constructor' && ts.isConstructorDeclaration(decl)) {
        const inj = nestInjections(this.resolver, decl);
        if (inj.length) out.injects = inj;
      }
      if (n.kind === 'class' && ts.isClassLike(decl)) {
        const mod = nestModule(this.resolver, decl, n.id, path);
        if (mod) modules.push(mod);
      }
      return out;
    });

    return {
      path,
      nodes,
      info: { path, test: isTestFile(path), hash: fs.fileHash, imports: this.fileImports(msf) },
      modules,
      globalPrefix: findGlobalPrefix(sf),
    };
  }

  private fileImports(sf: SourceFile): FileImport[] {
    const out: FileImport[] = [];
    for (const d of sf.getImportDeclarations()) {
      // A file with a syntax error can have an import without a string specifier.
      if (!ts.isStringLiteral(d.compilerNode.moduleSpecifier)) continue;
      const target = d.getModuleSpecifierSourceFile();
      const resolved = target ? this.rel(target.getFilePath()) : undefined;
      const names: string[] = [];
      const def = d.getDefaultImport();
      if (def) names.push(def.getText());
      const ns = d.getNamespaceImport();
      if (ns) names.push(ns.getText());
      for (const ni of d.getNamedImports()) names.push(ni.getName());
      out.push({
        spec: d.getModuleSpecifierValue(),
        ...(resolved && !resolved.endsWith('.d.ts') ? { resolved } : {}),
        names,
        ...(d.isTypeOnly() ? { typeOnly: true } : {}),
      });
    }
    for (const d of sf.getExportDeclarations()) {
      const ms = d.compilerNode.moduleSpecifier;
      if (!ms || !ts.isStringLiteral(ms)) continue;
      const spec = ms.text;
      const target = d.getModuleSpecifierSourceFile();
      const resolved = target ? this.rel(target.getFilePath()) : undefined;
      out.push({
        spec,
        ...(resolved ? { resolved } : {}),
        names: d.getNamedExports().map((e) => e.getName()),
      });
    }
    return out;
  }
}

/**
 * A Vite/Vue project's tsconfig.json often only lists references (`"files": []`,
 * `"references": [{ "path": "./tsconfig.app.json" }]`); the app config holds the
 * compiler options and path aliases.
 */
function appTsconfig(tsconfig: string): string {
  if (!existsSync(tsconfig)) return tsconfig;
  const { config } = ts.readConfigFile(tsconfig, ts.sys.readFile);
  const refs: { path: string }[] = config?.references ?? [];
  if (!refs.length || !Array.isArray(config.files) || config.files.length) return tsconfig;
  const candidates = refs
    .map((r) => resolve(dirname(tsconfig), r.path))
    .map((p) => (p.endsWith('.json') ? p : resolve(p, 'tsconfig.json')))
    .filter(existsSync);
  return candidates.find((p) => /app/.test(p.slice(dirname(p).length))) ?? candidates[0] ?? tsconfig;
}
