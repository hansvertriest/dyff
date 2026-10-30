import { ts } from 'ts-morph';
import { decoratorName, decoratorsOf, hash, nameOf } from './ast.js';
import { nestRoutes } from './nest.js';
import type { NodeKind, SymbolNode } from './schema.js';
import { collectVueRoutes } from './vue.js';

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
}

const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/,\s*([)\]>}])/g, '$1').replace(/([([{<]) /g, '$1').replace(/ ([)\]}>])/g, '$1').trim();
/** Signature without any formatting, for comparing base and PR versions. */
export const compactSignature = (s: string | undefined) => (s ?? '').replace(/\s+/g, '').replace(/,([)\]>}])/g, '$1');

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
    const routeOf = nestRoutes(c);

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
      const route = routeOf(m, mname);
      const extra: Partial<CollectedNode> = { signature: sig, ...decoratorList(m), ...(route ? { route } : {}) };
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

  collectVueRoutes(sf, add);

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
  return { path, nodes, byDecl, fileHash };
}
