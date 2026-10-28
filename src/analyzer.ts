import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { Project, ts, type SourceFile } from 'ts-morph';
import type { FileImport, FileInfo, Injection, ModuleImport, ModuleInfo, Provider, SymbolNode } from './schema.js';
import { collectFile, decoratorArgs, decoratorName, decoratorsOf, findGlobalPrefix, isTestFile, type FileSymbols } from './symbols.js';

export interface ProjectOptions {
  /** Directory node ids are relative to. Defaults to the current directory. */
  root?: string;
  /** tsconfig.json used for compiler options and path aliases. Defaults to <root>/tsconfig.json when present. */
  tsconfig?: string;
  /** Globs (relative to root) of files to index. */
  include?: string[];
  exclude?: string[];
}

export const DEFAULT_INCLUDE = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];
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
  private readonly symbolCache = new Map<string, FileSymbols>();

  constructor(opts: ProjectOptions = {}) {
    this.root = resolve(opts.root ?? process.cwd());
    const tsconfig = opts.tsconfig ? resolve(opts.tsconfig) : resolve(this.root, 'tsconfig.json');
    this.project = new Project({
      ...(existsSync(tsconfig) ? { tsConfigFilePath: tsconfig } : { compilerOptions: { experimentalDecorators: true, allowJs: false } }),
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: false,
    });
    const include = opts.include?.length ? opts.include : DEFAULT_INCLUDE;
    const exclude = [...DEFAULT_EXCLUDE, ...(opts.exclude ?? [])];
    this.project.addSourceFilesAtPaths([
      ...include.map((g) => resolve(this.root, g)),
      ...exclude.map((g) => '!' + resolve(this.root, g)),
    ]);
    this.checker = this.project.getTypeChecker().compilerObject;
  }

  /** Project-relative posix path, or undefined for files outside the root or in node_modules. */
  rel(abs: string): string | undefined {
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
    return this.project.getSourceFile(resolve(this.root, path));
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
      if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) {
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
        const inj = this.injections(decl);
        if (inj.length) out.injects = inj;
      }
      if (n.kind === 'class' && ts.isClassLike(decl)) {
        const mod = this.moduleDecl(decl, n.id, path);
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
      const spec = d.getModuleSpecifierValue();
      if (!spec) continue;
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

  /** Unwrap forwardRef(() => X). */
  private unwrapForwardRef(e: ts.Expression): { expr: ts.Expression; forwardRef: boolean } {
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'forwardRef') {
      const fn = e.arguments[0];
      if (fn && ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return { expr: fn.body, forwardRef: true };
      if (fn && ts.isArrowFunction(fn) && ts.isBlock(fn.body)) {
        const ret = fn.body.statements.find(ts.isReturnStatement);
        if (ret?.expression) return { expr: ret.expression, forwardRef: true };
      }
    }
    return { expr: e, forwardRef: false };
  }

  /** Expand array literals, spreads and `const X = [...]` references into element expressions. */
  private elements(e: ts.Expression | undefined, depth = 0): ts.Expression[] {
    if (!e || depth > 5) return [];
    while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    if (ts.isArrayLiteralExpression(e))
      return e.elements.flatMap((x) => (ts.isSpreadElement(x) ? this.elements(x.expression, depth + 1) : [x]));
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      const sym = this.resolveSymbol(e);
      const d = sym?.valueDeclaration;
      if (d && ts.isVariableDeclaration(d) && d.initializer && ts.isArrayLiteralExpression(d.initializer))
        return this.elements(d.initializer, depth + 1);
    }
    return [e];
  }

  private tokenOf(e: ts.Expression): string {
    if (ts.isStringLiteralLike(e)) return JSON.stringify(e.text);
    const { expr } = this.unwrapForwardRef(e);
    return this.targetOf(expr) ?? expr.getText();
  }

  private moduleDecl(c: ts.ClassLikeDeclaration, classId: string, file: string): Omit<ModuleInfo, 'id'> | undefined {
    const decos = decoratorsOf(c);
    const md = decos.find((d) => decoratorName(d) === 'Module');
    if (!md) return undefined;
    const arg = decoratorArgs(md)[0];
    const prop = (key: string) => {
      if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined;
      for (const p of arg.properties) {
        if (ts.isPropertyAssignment(p) && p.name.getText() === key) return p.initializer;
        if (ts.isShorthandPropertyAssignment(p) && p.name.text === key) return p.name;
      }
      return undefined;
    };

    const imports: ModuleImport[] = this.elements(prop('imports')).map((raw) => {
      const { expr: e0, forwardRef } = this.unwrapForwardRef(raw);
      let e = e0;
      let dynamic: string | undefined;
      if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
        dynamic = e.expression.name.text;
        e = e.expression.expression;
      }
      const classId = ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) ? this.targetOf(e) : undefined;
      return {
        name: ts.isIdentifier(e) ? e.text : e.getText().slice(0, 80),
        ...(classId ? { classId } : {}),
        external: !classId,
        ...(dynamic ? { dynamic } : {}),
        ...(forwardRef ? { forwardRef } : {}),
      };
    });

    const providers: Provider[] = this.elements(prop('providers')).map((e) => {
      if (ts.isObjectLiteralExpression(e)) {
        const get = (k: string) =>
          e.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === k)?.initializer;
        const provide = get('provide');
        const token = provide ? this.tokenOf(provide) : '?';
        for (const via of ['useClass', 'useExisting', 'useFactory', 'useValue'] as const) {
          const v = get(via);
          if (!v) continue;
          const inject = this.elements(get('inject')).map((x) => this.tokenOf(x));
          const target =
            via === 'useValue' ? undefined : ts.isIdentifier(v) || ts.isPropertyAccessExpression(v) ? this.targetOf(v) : undefined;
          return { token, via, ...(target ? { target } : {}), ...(inject.length ? { inject } : {}) };
        }
        return { token, via: 'unknown' as const };
      }
      const target = this.targetOf(e);
      return target ? { token: target, via: 'class' as const, target } : { token: e.getText(), via: 'unknown' as const };
    });

    const ids = (key: string) => this.elements(prop(key)).map((e) => this.tokenOf(e));
    return {
      name: c.name?.text ?? 'default',
      declared: true,
      file,
      classId,
      ...(decos.some((d) => decoratorName(d) === 'Global') ? { global: true } : {}),
      imports,
      providers,
      controllers: ids('controllers'),
      exports: ids('exports'),
    };
  }

  private injections(ctor: ts.ConstructorDeclaration): Injection[] {
    const out: Injection[] = [];
    for (const p of ctor.parameters) {
      const param = p.name.getText();
      const decos = decoratorsOf(p);
      const optional = decos.some((d) => decoratorName(d) === 'Optional') || undefined;
      const inj = decos.find((d) => decoratorName(d).startsWith('Inject'));
      if (inj) {
        const name = decoratorName(inj);
        const a = decoratorArgs(inj)[0];
        if (a) {
          const { expr, forwardRef } = this.unwrapForwardRef(a);
          const target = ts.isStringLiteralLike(expr) ? undefined : this.targetOf(expr);
          const isClass = !!((this.resolveSymbol(expr)?.flags ?? 0) & ts.SymbolFlags.Class);
          out.push({
            param,
            kind: name === 'Inject' ? (isClass ? 'class' : 'token') : name === 'InjectRepository' ? 'repository' : 'decorator',
            token: ts.isStringLiteralLike(expr) ? JSON.stringify(expr.text) : (target ?? expr.getText()),
            ...(target ? { target } : {}),
            ...(name !== 'Inject' ? { decorator: name } : {}),
            ...(forwardRef ? { forwardRef } : {}),
            ...(optional ? { optional } : {}),
          });
          continue;
        }
      }
      if (p.type && ts.isTypeReferenceNode(p.type)) {
        const target = this.targetOf(p.type.typeName);
        out.push({
          param,
          kind: 'class',
          token: target ?? p.type.typeName.getText(),
          ...(target ? { target } : {}),
          ...(optional ? { optional } : {}),
        });
      }
    }
    return out;
  }
}
