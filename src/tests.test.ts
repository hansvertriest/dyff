import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ts } from 'ts-morph';
import { collectTests, describeAssertions, say } from './tests.js';

/** Unit tests of `tests.ts`, in TypeScript so that dyffle indexes them as test cases of its own code. */

const parse = (text: string) => ts.createSourceFile('x.spec.ts', text, ts.ScriptTarget.Latest, true);
const firstExpression = (text: string) => (parse(text).statements[0] as ts.ExpressionStatement).expression;

describe('collectTests', () => {
  it('finds it and test calls with the describe blocks around them', () => {
    const found = collectTests(parse("describe('Cart', () => { describe('total', () => { it('sums', () => {}); }); test('counts', () => {}); });"));
    assert.deepEqual(found.map((f) => [f.testCase.suites, f.testCase.title]), [
      [['Cart', 'total'], 'sums'],
      [['Cart'], 'counts'],
    ]);
  });

  it('marks skipped, focused and placeholder tests', () => {
    const found = collectTests(parse("it.skip('a', () => {}); fit('b', () => {}); it.todo('c'); it('d', { skip: true }, () => {});"));
    assert.deepEqual(found.map((f) => f.testCase.mode), ['skip', 'only', 'todo', 'skip']);
  });

  it('takes the title of test.each with its placeholders', () => {
    const [t] = collectTests(parse("test.each([1, 2])('works for %s', (n) => {});"));
    assert.equal(t.testCase.title, 'works for %s');
  });

  it('keeps a subtest as part of the test around it', () => {
    const found = collectTests(parse("it('outer', async (t) => { await t.test('inner', () => {}); });"));
    assert.deepEqual(found.map((f) => f.testCase.title), ['outer']);
  });

  it('skips calls that are not tests', () => {
    assert.deepEqual(collectTests(parse("it('no body'); render('x', () => {});")), []);
  });

  it('does not mark a test skipped when its skip option is false', () => {
    const [t] = collectTests(parse("it('runs', { skip: false }, () => {});"));
    assert.equal(t.testCase.mode, undefined);
  });

  it('describes the assertions in each test body', () => {
    const [t] = collectTests(parse("it('adds', () => { expect(add(1, 2)).toBe(3); });"));
    assert.deepEqual(t.testCase.expects, ['expects add(1, 2) to be 3']);
  });
});

describe('describeAssertions', () => {
  it('phrases an expect chain with its matcher in words', () => {
    assert.deepEqual(describeAssertions(parse('expect(cart.count()).toBe(2);')), ['expects cart.count() to be 2']);
    assert.deepEqual(describeAssertions(parse("expect(cart.has('x')).not.toBe(true);")), ["expects cart.has('x') not to be true"]);
  });

  it('says a rejected promise rejects with the error', () => {
    assert.deepEqual(describeAssertions(parse('await expect(service.findOne(9)).rejects.toThrow(NotFoundException);')), ['expects service.findOne(9) to reject with NotFoundException']);
  });

  it('counts calls in words', () => {
    assert.deepEqual(describeAssertions(parse('expect(repo.save).toHaveBeenCalledTimes(2);')), ['expects repo.save to have been called 2 times']);
  });

  it('phrases node:assert calls', () => {
    assert.deepEqual(describeAssertions(parse('assert.equal(total(), 0); assert.ok(isEmpty());')), ['expects total() to equal 0', 'expects isEmpty()']);
  });

  it('phrases assertions through the test context', () => {
    assert.deepEqual(describeAssertions(parse('t.assert.strictEqual(size(), 1);')), ['expects size() to equal 1']);
  });

  it('reads a Chai chain word by word', () => {
    assert.deepEqual(describeAssertions(parse('expect(list).to.deep.equal([1]);')), ['expects list to deep equal [1]']);
  });

  it('says a resolved promise resolves to its value', () => {
    assert.deepEqual(describeAssertions(parse('await expect(load()).resolves.toEqual(3);')), ['expects load() to resolve to equal 3']);
  });

  it('names the class an instance is expected to be', () => {
    assert.deepEqual(describeAssertions(parse('expect(err).toBeInstanceOf(HttpError);')), ['expects err to be an instance of HttpError']);
  });

  it('says only once an assertion repeated in a row', () => {
    assert.deepEqual(describeAssertions(parse('for (const x of xs) { expect(x).toBeTruthy(); expect(x).toBeTruthy(); }')), ['expects x to be truthy']);
  });

  it('ignores calls that are not assertions', () => {
    assert.deepEqual(describeAssertions(parse('cart.add(1); console.log(cart);')), []);
  });
});

describe('say', () => {
  it('keeps a short expression as it is', () => {
    assert.equal(say(firstExpression('service.findOne(1)')), 'service.findOne(1)');
  });

  it('names a long object literal instead of showing it', () => {
    assert.equal(say(firstExpression(`({ ${Array.from({ length: 12 }, (_, i) => `key${i}: ${i}`).join(', ')} })`)), 'an object');
  });

  it('reads through an arrow function to what it calls', () => {
    assert.equal(say(firstExpression("() => parse('x')")), "parse('x')");
  });

  it('calls a function with more than one statement a function', () => {
    assert.equal(say(firstExpression('() => { a(); b(); }')), 'a function');
  });

  it('shortens a long call to its callee', () => {
    assert.equal(say(firstExpression(`build(${'x, '.repeat(30)}y)`)), 'build(…)');
  });

  it('counts the items of a long list', () => {
    assert.equal(say(firstExpression(`[${Array.from({ length: 30 }, (_, i) => i).join(', ')}]`)), 'a list of 30');
  });

  it('reads through parentheses and type assertions', () => {
    assert.equal(say(firstExpression('(repo.find() as Item)!')), 'repo.find()');
  });
});
