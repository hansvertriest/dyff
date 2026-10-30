import { createHash } from 'node:crypto';
import { ts } from 'ts-morph';

/** Syntax helpers shared by the general indexer and the framework support (nest.ts, vue.ts). */

export const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

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

export function joinPath(...parts: (string | undefined)[]): string {
  const joined = parts
    .filter((p): p is string => !!p)
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '');
  return '/' + joined;
}

export function nameOf(n: ts.Node & { name?: ts.Node }): string | undefined {
  const nm = n.name;
  if (!nm) return undefined;
  if (ts.isIdentifier(nm) || ts.isPrivateIdentifier(nm) || ts.isStringLiteral(nm) || ts.isNumericLiteral(nm)) return nm.text;
  if (ts.isComputedPropertyName(nm)) return `[${nm.expression.getText()}]`;
  return nm.getText();
}
