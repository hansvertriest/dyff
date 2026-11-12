import { ts } from 'ts-morph';
import type { TestCase } from './schema.js';

/** Test frameworks (Jest, Vitest, Mocha, node:test, Chai): finding test cases and saying what they check in words. */

const SUITE_FNS = new Set(['describe', 'context', 'suite', 'xdescribe', 'fdescribe', 'xcontext']);
const TEST_FNS = new Set(['it', 'test', 'specify', 'xit', 'fit', 'xtest']);
const ASSERT_ROOTS = new Set(['expect', 'assert']);

/** A test case found in a file: the `it`/`test` call and its description. */
export interface FoundTest {
  call: ts.CallExpression;
  testCase: TestCase;
}

interface Callee {
  fn: string;
  mods: string[];
}

/** `it`, `it.only`, `test.each(rows)`, `describe.skip`... as the base name and its modifiers. */
function calleeOf(e: ts.Expression): Callee | undefined {
  const mods: string[] = [];
  for (;;) {
    if (ts.isIdentifier(e)) return { fn: e.text, mods };
    if (ts.isPropertyAccessExpression(e)) {
      mods.unshift(e.name.text);
      e = e.expression;
    } else if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'each') {
      // test.each(rows)('title %s', fn)
      e = e.expression;
    } else return undefined;
  }
}

function titleOf(e: ts.Expression | undefined): string {
  if (!e) return '';
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isTemplateExpression(e)) return e.getText().slice(1, -1);
  if (ts.isFunctionLike(e) || ts.isIdentifier(e)) return ts.isIdentifier(e) ? e.text : '';
  return e.getText();
}

function modeOf(c: Callee, args: readonly ts.Expression[]): TestCase['mode'] {
  const flags = new Set(c.mods);
  if (c.fn.startsWith('x')) flags.add('skip');
  if (c.fn.startsWith('f')) flags.add('only');
  // node:test: it('title', { skip: true }, fn)
  const opts = args.find(ts.isObjectLiteralExpression);
  for (const p of opts?.properties ?? []) {
    const name = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
    const off = ts.isPropertyAssignment(p) && p.initializer.kind === ts.SyntaxKind.FalseKeyword;
    if (name && !off) flags.add(name);
  }
  if (flags.has('todo')) return 'todo';
  if (flags.has('skip')) return 'skip';
  if (flags.has('only')) return 'only';
  return undefined;
}

/**
 * Find the test cases of a test file, with the suites around them. A test inside
 * another test (a subtest) is part of the outer one.
 */
export function collectTests(sf: ts.SourceFile): FoundTest[] {
  const out: FoundTest[] = [];
  const visit = (n: ts.Node, suites: string[]) => {
    if (ts.isCallExpression(n)) {
      const c = calleeOf(n.expression);
      if (c && SUITE_FNS.has(c.fn)) {
        const inner = [...suites, titleOf(n.arguments[0])];
        for (const a of n.arguments) visit(a, inner);
        return;
      }
      const body = [...n.arguments].reverse().find((a) => ts.isFunctionLike(a));
      if (c && TEST_FNS.has(c.fn) && n.arguments.length && (body || c.mods.includes('todo'))) {
        const mode = modeOf(c, n.arguments);
        out.push({
          call: n,
          testCase: {
            title: titleOf(n.arguments[0]),
            suites,
            expects: body ? describeAssertions(body) : [],
            ...(mode ? { mode } : {}),
          },
        });
        return;
      }
    }
    ts.forEachChild(n, (c) => visit(c, suites));
  };
  visit(sf, []);
  return out;
}

const MAX = 60;
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function unwrap(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    else return e;
  }
}

/** A short, readable rendering of an expression: its text when short, otherwise what kind of thing it is. */
export function say(e: ts.Expression | undefined): string {
  if (!e) return '';
  e = unwrap(e);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
    const b = e.body;
    if (!ts.isBlock(b)) return say(b);
    if (b.statements.length === 1) {
      const st = b.statements[0];
      if (ts.isExpressionStatement(st)) return say(st.expression);
      if (ts.isReturnStatement(st) && st.expression) return say(st.expression);
    }
    return 'a function';
  }
  const text = oneLine(e.getText());
  if (text.length <= MAX) return text;
  if (ts.isCallExpression(e) || ts.isNewExpression(e)) return `${oneLine(e.expression.getText())}(…)`;
  if (ts.isObjectLiteralExpression(e)) return 'an object';
  if (ts.isArrayLiteralExpression(e)) return `a list of ${e.elements.length}`;
  return text.slice(0, MAX - 1) + '…';
}

/** "toHaveBeenCalledWith" -> "to have been called with". */
const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

type Segment = { name: string } | { args: readonly ts.Expression[] };

/** The chain `a.b(c).d(e)` as its root expression and the segments after it. */
function chainOf(top: ts.Expression): { root: ts.Expression; segs: Segment[] } {
  const segs: Segment[] = [];
  let e = top;
  for (;;) {
    e = unwrap(e);
    if (ts.isCallExpression(e)) {
      segs.unshift({ args: e.arguments });
      e = e.expression;
    } else if (ts.isPropertyAccessExpression(e)) {
      segs.unshift({ name: e.name.text });
      e = e.expression;
    } else return { root: e, segs };
  }
}

const argList = (args: readonly ts.Expression[]) => args.map(say).filter(Boolean).join(', ');

/** expect(x).not.toBe(y), expect(x).to.deep.equal(y), await expect(p).rejects.toThrow(E). */
function sayExpect(subject: ts.Expression | undefined, segs: Segment[]): string {
  const parts = ['expects', say(subject)];
  let afterPromise = false;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if ('args' in s) {
      if (s.args.length) parts.push(argList(s.args));
      continue;
    }
    const next = segs[i + 1];
    const args = next && 'args' in next ? next.args : undefined;
    if (s.name === 'resolves' || s.name === 'rejects') {
      parts.push(s.name === 'resolves' ? 'to resolve' : 'to reject');
      afterPromise = true;
    } else if (afterPromise && s.name === 'toThrow') {
      parts.push(args?.length ? 'with' : '');
    } else if (s.name === 'toHaveBeenCalledTimes' || s.name === 'toBeCalledTimes') {
      parts.push(`to have been called ${args?.length ? argList(args) : ''} times`);
      i++;
    } else if (s.name === 'toBeInstanceOf') {
      parts.push('to be an instance of');
    } else {
      parts.push(words(s.name));
    }
  }
  return oneLine(parts.filter(Boolean).join(' '));
}

const NODE_ASSERT: Record<string, string> = {
  equal: 'to equal',
  strictEqual: 'to equal',
  deepEqual: 'to equal',
  deepStrictEqual: 'to equal',
  notEqual: 'not to equal',
  notStrictEqual: 'not to equal',
  notDeepEqual: 'not to equal',
  notDeepStrictEqual: 'not to equal',
  throws: 'to throw',
  doesNotThrow: 'not to throw',
  rejects: 'to reject with',
  doesNotReject: 'not to reject',
  match: 'to match',
  doesNotMatch: 'not to match',
};

/** assert(x), assert.equal(a, b), assert.throws(fn, E), t.assert.ok(x). */
function sayAssert(method: string | undefined, args: readonly ts.Expression[]): string {
  if (!method || method === 'ok') return `expects ${say(args[0])}`;
  if (method === 'fail') return 'fails';
  const verb = NODE_ASSERT[method] ?? words(method);
  return oneLine(`expects ${say(args[0])} ${verb} ${argList(args.slice(1, 2))}`);
}

/** One sentence for an assertion expression, or undefined when it is not one. */
function sayAssertion(top: ts.Expression): string | undefined {
  const { root, segs } = chainOf(top);
  if (!ts.isIdentifier(root)) return undefined;
  if (root.text === 'expect' && segs[0] && 'args' in segs[0]) return sayExpect(segs[0].args[0], segs.slice(1));
  // `assert(...)`, `assert.x(...)`, `t.assert.x(...)`
  const at = root.text === 'assert' ? 0 : segs.findIndex((s) => 'name' in s && s.name === 'assert') + 1;
  if (at === 0 && root.text !== 'assert') return undefined;
  const after = segs.slice(at);
  const call = after.find((s): s is { args: readonly ts.Expression[] } => 'args' in s);
  if (!call) return undefined;
  const method = after.find((s): s is { name: string } => 'name' in s)?.name;
  return sayAssert(method, call.args);
}

/** The assertions in a test's body, one sentence each, in source order. */
export function describeAssertions(body: ts.Node): string[] {
  const out: string[] = [];
  const isChainLink = (n: ts.Node): boolean =>
    (ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n) ||
    (ts.isCallExpression(n.parent) && n.parent.expression === n) ||
    ((ts.isAwaitExpression(n.parent) || ts.isParenthesizedExpression(n.parent) || ts.isNonNullExpression(n.parent)) && isChainLink(n.parent));
  const visit = (n: ts.Node) => {
    if ((ts.isCallExpression(n) || ts.isPropertyAccessExpression(n)) && !isChainLink(n)) {
      const { root } = chainOf(n);
      if (ts.isIdentifier(root) && (ASSERT_ROOTS.has(root.text) || /\.assert\./.test(n.getText()))) {
        const s = sayAssertion(n);
        if (s) {
          if (out[out.length - 1] !== s) out.push(s);
          return;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return out;
}
