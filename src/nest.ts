import { ts } from 'ts-morph';
import { decoratorArgs, decoratorName, decoratorsOf, joinPath, literalText } from './ast.js';
import type { Index, Injection, ModuleImport, ModuleInfo, Provider, Route } from './schema.js';

/**
 * NestJS support: routes from decorators (@Get, @MessagePattern, @Query, @Cron, ...),
 * @Module metadata, constructor injection and app.setGlobalPrefix.
 */

const HTTP_VERBS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'All', 'Options', 'Head', 'Search']);
const ROUTE_DECORATORS: Record<string, Route['type']> = {
  MessagePattern: 'message',
  EventPattern: 'message',
  GrpcMethod: 'message',
  Query: 'graphql',
  Mutation: 'graphql',
  Subscription: 'graphql',
  ResolveField: 'graphql',
  Cron: 'schedule',
  Interval: 'schedule',
  Timeout: 'schedule',
  OnEvent: 'event',
};

function stringArg(d: ts.Decorator | undefined, objectKey?: string): string {
  if (!d) return '';
  const a = decoratorArgs(d)[0];
  if (!a) return '';
  if (ts.isObjectLiteralExpression(a) && objectKey) {
    for (const p of a.properties)
      if (ts.isPropertyAssignment(p) && p.name.getText() === objectKey) return literalText(p.initializer) ?? '';
    return '';
  }
  return literalText(a) ?? '';
}

/** GraphQL operation name: `@Query('users')` or `@Query(() => [User], { name: 'users' })`, never the type function. */
function graphqlName(d: ts.Decorator): string {
  for (const a of decoratorArgs(d)) {
    if (ts.isStringLiteralLike(a)) return a.text;
    if (ts.isObjectLiteralExpression(a))
      for (const p of a.properties)
        if (ts.isPropertyAssignment(p) && p.name.getText() === 'name') return literalText(p.initializer) ?? '';
  }
  return '';
}

/** Route of each method of a class: HTTP routes in a @Controller, GraphQL operations in a @Resolver, and message, schedule and event handlers. */
export function nestRoutes(c: ts.ClassLikeDeclaration): (m: ts.ClassElement, name: string) => Route | undefined {
  const ctrl = decoratorsOf(c).find((d) => decoratorName(d) === 'Controller');
  const resolver = decoratorsOf(c).some((d) => decoratorName(d) === 'Resolver');
  const prefix = stringArg(ctrl, 'path');
  return (m, name) => {
    for (const d of decoratorsOf(m)) {
      const dn = decoratorName(d);
      if (ctrl && HTTP_VERBS.has(dn)) {
        const p = stringArg(d, 'path');
        return { type: 'http', verb: dn.toUpperCase(), path: p, fullPath: joinPath(prefix, p) };
      }
      const type = ROUTE_DECORATORS[dn];
      if (type && (type !== 'graphql' || resolver))
        return { type, verb: dn, path: (type === 'graphql' ? graphqlName(d) : stringArg(d, 'name')) || name };
    }
    return undefined;
  };
}

/** Find `app.setGlobalPrefix('x')` in a file. */
export function findGlobalPrefix(sf: ts.SourceFile): string | undefined {
  let found: string | undefined;
  const visit = (n: ts.Node) => {
    if (found !== undefined) return;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'setGlobalPrefix' &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      found = n.arguments[0].text;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** Reference resolution the Nest metadata needs, provided by the Analyzer. */
export interface Resolver {
  /** Node id an expression refers to. */
  targetOf(node: ts.Node): string | undefined;
  /** The symbol an expression refers to, with aliases resolved. */
  resolveSymbol(node: ts.Node): ts.Symbol | undefined;
}

/** Unwrap forwardRef(() => X). */
function unwrapForwardRef(e: ts.Expression): { expr: ts.Expression; forwardRef: boolean } {
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
function elements(r: Resolver, e: ts.Expression | undefined, depth = 0): ts.Expression[] {
  if (!e || depth > 5) return [];
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  if (ts.isArrayLiteralExpression(e))
    return e.elements.flatMap((x) => (ts.isSpreadElement(x) ? elements(r, x.expression, depth + 1) : [x]));
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
    const sym = r.resolveSymbol(e);
    const d = sym?.valueDeclaration;
    if (d && ts.isVariableDeclaration(d) && d.initializer && ts.isArrayLiteralExpression(d.initializer))
      return elements(r, d.initializer, depth + 1);
  }
  return [e];
}

function tokenOf(r: Resolver, e: ts.Expression): string {
  if (ts.isStringLiteralLike(e)) return JSON.stringify(e.text);
  const { expr } = unwrapForwardRef(e);
  return r.targetOf(expr) ?? expr.getText();
}

/** A class's @Module metadata: imports (dynamic and forwardRef ones too), providers, controllers and exports. */
export function nestModule(r: Resolver, c: ts.ClassLikeDeclaration, classId: string, file: string): Omit<ModuleInfo, 'id'> | undefined {
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

  const imports: ModuleImport[] = elements(r, prop('imports')).map((raw) => {
    const { expr: e0, forwardRef } = unwrapForwardRef(raw);
    let e = e0;
    let dynamic: string | undefined;
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      dynamic = e.expression.name.text;
      e = e.expression.expression;
    }
    const classId = ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) ? r.targetOf(e) : undefined;
    return {
      name: ts.isIdentifier(e) ? e.text : e.getText().slice(0, 80),
      ...(classId ? { classId } : {}),
      external: !classId,
      ...(dynamic ? { dynamic } : {}),
      ...(forwardRef ? { forwardRef } : {}),
    };
  });

  const providers: Provider[] = elements(r, prop('providers')).map((e) => {
    if (ts.isObjectLiteralExpression(e)) {
      const get = (k: string) =>
        e.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === k)?.initializer;
      const provide = get('provide');
      const token = provide ? tokenOf(r, provide) : '?';
      for (const via of ['useClass', 'useExisting', 'useFactory', 'useValue'] as const) {
        const v = get(via);
        if (!v) continue;
        const inject = elements(r, get('inject')).map((x) => tokenOf(r, x));
        const target =
          via === 'useValue' ? undefined : ts.isIdentifier(v) || ts.isPropertyAccessExpression(v) ? r.targetOf(v) : undefined;
        return { token, via, ...(target ? { target } : {}), ...(inject.length ? { inject } : {}) };
      }
      return { token, via: 'unknown' as const };
    }
    const target = r.targetOf(e);
    return target ? { token: target, via: 'class' as const, target } : { token: e.getText(), via: 'unknown' as const };
  });

  const ids = (key: string) => elements(r, prop(key)).map((e) => tokenOf(r, e));
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

/** What a constructor injects: by class type, @Inject token, @InjectRepository and other @Inject* decorators. */
export function nestInjections(r: Resolver, ctor: ts.ConstructorDeclaration): Injection[] {
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
        const { expr, forwardRef } = unwrapForwardRef(a);
        const target = ts.isStringLiteralLike(expr) ? undefined : r.targetOf(expr);
        const isClass = !!((r.resolveSymbol(expr)?.flags ?? 0) & ts.SymbolFlags.Class);
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
      const target = r.targetOf(p.type.typeName);
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

/** Point injections at what provides them: string and symbol tokens, and classes provided with useClass / useExisting / useFactory. */
export function resolveInjectionTokens(index: Index): void {
  const providerTarget = new Map<string, string>();
  for (const m of index.modules)
    for (const p of m.providers) if (p.target && !providerTarget.has(p.token)) providerTarget.set(p.token, p.target);
  for (const n of index.nodes)
    for (const inj of n.injects ?? []) {
      if (inj.kind === 'class' && inj.target && providerTarget.has(inj.target) && providerTarget.get(inj.target) !== inj.target) {
        inj.target = providerTarget.get(inj.target);
      } else if (!inj.target || inj.kind === 'token') {
        const t = providerTarget.get(inj.token);
        if (t) inj.target = t;
      }
    }
}
