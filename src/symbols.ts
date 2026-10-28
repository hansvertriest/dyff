import { createHash } from 'node:crypto';
import { ts } from 'ts-morph';
import type { NodeKind, Route, SymbolNode } from './schema.js';

/** A node as collected from one file, before references are resolved. */
export interface CollectedNode extends Omit<SymbolNode, 'module' | 'uses' | 'references'> {
  decl: ts.Node;
}

export interface FileSymbols {
  path: string;
  nodes: CollectedNode[];
  /** Declaration node -> node id. */
  byDecl: Map<ts.Node, string>;
  /** Hash of the file-level code (imports and top-level statements that are not nodes). */
  fileHash: string;
  /** Controller prefix per class id. */
  controllerPrefix: Map<string, string>;
}

export const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);
const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/,\s*([)\]>}])/g, '$1').replace(/([([{<]) /g, '$1').replace(/ ([)\]}>])/g, '$1').trim();
/** Signature without any formatting, for comparing base and PR versions. */
export const compactSignature = (s: string | undefined) => (s ?? '').replace(/\s+/g, '').replace(/,([)\]>}])/g, '$1');

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

export function decoratorsOf(node: ts.Node): ts.Decorator[] {
  return ts.canHaveDecorators(node) ? [...(ts.getDecorators(node) ?? [])] : [];
}

export function decoratorName(d: ts.Decorator): string {
  let e = d.expression;
  if (ts.isCallExpression(e)) e = e.expression;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isIdentifier(e)) return e.text;
  return e.getText();
}

export function decoratorArgs(d: ts.Decorator): readonly ts.Expression[] {
  return ts.isCallExpression(d.expression) ? d.expression.arguments : [];
}

/** Literal text of a string-ish expression, or its source text. */
export function literalText(e: ts.Expression | undefined): string | undefined {
  if (!e) return undefined;
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isArrayLiteralExpression(e)) return e.elements.map((x) => literalText(x)).filter(Boolean).join('|');
  return e.getText();
}

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

export function joinPath(...parts: (string | undefined)[]): string {
  const joined = parts
    .filter((p): p is string => !!p)
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '');
  return '/' + joined;
}

function nameOf(n: ts.Node & { name?: ts.Node }): string | undefined {
  const nm = n.name;
  if (!nm) return undefined;
  if (ts.isIdentifier(nm) || ts.isPrivateIdentifier(nm) || ts.isStringLiteral(nm) || ts.isNumericLiteral(nm)) return nm.text;
  if (ts.isComputedPropertyName(nm)) return `[${nm.expression.getText()}]`;
  return nm.getText();
}

function lineOf(sf: ts.SourceFile, pos: number) {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function hasModifier(n: ts.Node, kind: ts.SyntaxKind) {
  return ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === kind);
}

function modifierText(n: ts.Node): string {
  if (!ts.canHaveModifiers(n)) return '';
  return (ts.getModifiers(n) ?? [])
    .filter((m) => m.kind !== ts.SyntaxKind.ExportKeyword && m.kind !== ts.SyntaxKind.DefaultKeyword)
    .map((m) => m.getText())
    .join(' ');
}

function paramText(p: ts.ParameterDeclaration): string {
  return (
    (p.dotDotDotToken ? '...' : '') +
    p.name.getText() +
    (p.questionToken ? '?' : '') +
    (p.type ? ': ' + p.type.getText() : '') +
    (p.initializer ? ' = ' + p.initializer.getText() : '')
  );
}

function fnSignature(n: ts.SignatureDeclarationBase, mods: string): string {
  const tps = n.typeParameters ? `<${n.typeParameters.map((t) => t.getText()).join(', ')}>` : '';
  const ret = n.type ? ': ' + n.type.getText() : '';
  return norm(`${mods} ${tps}(${n.parameters.map(paramText).join(', ')})${ret}`);
}

function isFunctionInit(e: ts.Expression | undefined): e is ts.ArrowFunction | ts.FunctionExpression {
  return !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
}

export function isTestFile(path: string): boolean {
  return /\.(spec|test|e2e-spec|e2e)\.[cm]?tsx?$/.test(path) || /(^|\/)(test|tests|__tests__)\//.test(path);
}

/**
 * Collect the declarations of one file: classes and their members, functions,
 * top-level variables, interfaces, types and enums. Works without a type checker.
 */
export function collectFile(sf: ts.SourceFile, path: string): FileSymbols {
  const nodes: CollectedNode[] = [];
  const byDecl = new Map<ts.Node, string>();
  const ids = new Map<string, CollectedNode>();
  const controllerPrefix = new Map<string, string>();
  const test = isTestFile(path);
  const topLevelOther: string[] = [];

  const add = (decl: ts.Node, kind: NodeKind, name: string, extra: Partial<CollectedNode> = {}, parent?: string) => {
    const id = parent ? `${parent}.${name}` : `${path}#${name}`;
    const range: [number, number] = [lineOf(sf, decl.getStart(sf)), lineOf(sf, decl.getEnd())];
    const existing = ids.get(id);
    byDecl.set(decl, id);
    if (existing) {
      // Overloads and get/set pairs share one id.
      existing.range = [Math.min(existing.range[0], range[0]), Math.max(existing.range[1], range[1])];
      existing.hash = hash(existing.hash + decl.getText(sf));
      if (extra.signature && existing.signature && !existing.signature.includes(extra.signature))
        existing.signature += ' | ' + extra.signature;
      return existing;
    }
    const node: CollectedNode = {
      id,
      kind,
      name,
      file: path,
      range,
      hash: hash(decl.getText(sf)),
      decl,
      ...(parent ? { parent } : {}),
      ...(test ? { test } : {}),
      ...extra,
    };
    ids.set(id, node);
    nodes.push(node);
    return node;
  };

  const decoratorList = (n: ts.Node) => {
    const ds = decoratorsOf(n).map(decoratorName);
    return ds.length ? { decorators: ds } : {};
  };

  const visitClass = (c: ts.ClassLikeDeclaration, name: string, exported: boolean) => {
    const heritage = (c.heritageClauses ?? []).map((h) => h.getText()).join(' ');
    const tps = c.typeParameters ? `<${c.typeParameters.map((t) => t.getText()).join(', ')}>` : '';
    const cls = add(c, 'class', name, {
      exported,
      signature: norm(`${modifierText(c)} ${tps} ${heritage}`) || undefined,
      ...decoratorList(c),
    });
    const ctrl = decoratorsOf(c).find((d) => decoratorName(d) === 'Controller');
    const resolver = decoratorsOf(c).some((d) => decoratorName(d) === 'Resolver');
    const prefix = stringArg(ctrl, 'path');
    if (ctrl) controllerPrefix.set(cls.id, prefix);

    for (const m of c.members) {
      let kind: NodeKind | null = null;
      let sig: string | undefined;
      let mname = nameOf(m as ts.Node & { name?: ts.Node });
      if (ts.isConstructorDeclaration(m)) {
        kind = 'constructor';
        mname = 'constructor';
        sig = fnSignature(m, modifierText(m));
      } else if (ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
        kind = 'method';
        const acc = ts.isGetAccessorDeclaration(m) ? 'get ' : ts.isSetAccessorDeclaration(m) ? 'set ' : '';
        sig = fnSignature(m, `${modifierText(m)} ${acc}`);
      } else if (ts.isPropertyDeclaration(m) && isFunctionInit(m.initializer)) {
        kind = 'method';
        sig = fnSignature(m.initializer, modifierText(m));
      }
      if (!kind || !mname) continue;
      const extra: Partial<CollectedNode> = { signature: sig, ...decoratorList(m) };
      for (const d of decoratorsOf(m)) {
        const dn = decoratorName(d);
        if (ctrl && HTTP_VERBS.has(dn)) {
          const p = stringArg(d, 'path');
          extra.route = { type: 'http', verb: dn.toUpperCase(), path: p, fullPath: joinPath(prefix, p) };
          break;
        }
        const type = ROUTE_DECORATORS[dn];
        if (type && (type !== 'graphql' || resolver)) {
          extra.route = { type, verb: dn, path: (type === 'graphql' ? graphqlName(d) : stringArg(d, 'name')) || mname };
          break;
        }
      }
      add(m, kind, mname, extra, cls.id);
    }
  };

  for (const st of sf.statements) {
    const exported = hasModifier(st, ts.SyntaxKind.ExportKeyword);
    if (ts.isClassDeclaration(st)) {
      visitClass(st, st.name?.text ?? 'default', exported);
    } else if (ts.isFunctionDeclaration(st)) {
      add(st, 'function', st.name?.text ?? 'default', { exported, signature: fnSignature(st, modifierText(st)) });
    } else if (ts.isVariableStatement(st)) {
      let any = false;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        any = true;
        // A variable statement with one declaration is hashed whole, so `export`/`const` changes count.
        const declNode = st.declarationList.declarations.length === 1 ? st : d;
        if (isFunctionInit(d.initializer)) {
          add(declNode, 'function', d.name.text, { exported, signature: fnSignature(d.initializer, modifierText(d.initializer)) });
        } else if (d.initializer && ts.isClassExpression(d.initializer)) {
          visitClass(d.initializer, d.name.text, exported);
        } else {
          add(declNode, 'variable', d.name.text, { exported, signature: d.type ? norm(d.type.getText()) : undefined });
        }
        if (declNode !== d) byDecl.set(d, byDecl.get(declNode)!);
      }
      if (!any) topLevelOther.push(st.getText(sf));
    } else if (ts.isInterfaceDeclaration(st)) {
      add(st, 'interface', st.name.text, { exported });
    } else if (ts.isTypeAliasDeclaration(st)) {
      add(st, 'type', st.name.text, { exported });
    } else if (ts.isEnumDeclaration(st)) {
      add(st, 'enum', st.name.text, { exported });
    } else {
      topLevelOther.push(st.getText(sf));
    }
  }

  const fileHash = hash(topLevelOther.join('\n'));
  const fileNode: CollectedNode = {
    id: path,
    kind: 'file',
    name: path.slice(path.lastIndexOf('/') + 1),
    file: path,
    range: [1, Math.max(1, sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1)],
    hash: fileHash,
    decl: sf,
    ...(test ? { test } : {}),
  };
  byDecl.set(sf, path);
  nodes.unshift(fileNode);
  return { path, nodes, byDecl, fileHash, controllerPrefix };
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
