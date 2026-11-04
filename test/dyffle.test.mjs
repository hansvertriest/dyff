import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildBaseIndex, buildOverlay, embedSection, LiveSession, markdownReport, merge, mermaidModuleMap, parseUnifiedDiff, query, queryMarkdown, reach, reachGraph, readPostInput, readReviewInput, rebase, removeWorktreeRefs, reverseApply, reviewsMarkdown, serve, sliceHunks, standaloneHtml, worktreeId } from '../dist/index.js';

const fixture = fileURLToPath(new URL('./fixtures/nest-app/', import.meta.url));
const vueFixture = fileURLToPath(new URL('./fixtures/vue-app/', import.meta.url));
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=dyffle', '-c', 'user.email=dyffle@example.com', ...args], { cwd, encoding: 'utf8' });

describe('diff', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    'index 1..2 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,4 +1,4 @@',
    ' line1',
    '-line2',
    '+line2 changed',
    ' line3',
    ' line4',
    '@@ -9,2 +9,3 @@ class X {',
    ' line9',
    '+inserted',
    ' line10',
    '',
  ].join('\n');

  it('parses files, hunks and line numbers', () => {
    const [f] = parseUnifiedDiff(diff);
    assert.equal(f.path, 'a.ts');
    assert.equal(f.status, 'modified');
    assert.equal(f.hunks.length, 2);
    assert.deepEqual([f.additions, f.deletions], [2, 1]);
    assert.deepEqual(f.hunks[1].lines.map((l) => [l.t, l.o, l.n]), [
      [' ', 9, 9],
      ['+', undefined, 10],
      [' ', 10, 11],
    ]);
  });

  it('rebuilds the base side by reverse-applying hunks', () => {
    const [f] = parseUnifiedDiff(diff);
    const newText = ['line1', 'line2 changed', 'line3', 'line4', 'l5', 'l6', 'l7', 'l8', 'line9', 'inserted', 'line10', ''].join('\n');
    assert.equal(reverseApply(newText, f.hunks), ['line1', 'line2', 'line3', 'line4', 'l5', 'l6', 'l7', 'l8', 'line9', 'line10', ''].join('\n'));
    assert.equal(reverseApply('something else', f.hunks), null);
  });

  it('slices hunks to a node range', () => {
    const [f] = parseUnifiedDiff(diff);
    const sliced = sliceHunks(f.hunks, [9, 11], [9, 10]);
    assert.equal(sliced.length, 1);
    assert.deepEqual(sliced[0].lines.map((l) => l.text), ['line9', 'inserted', 'line10']);
  });
});

describe('NestJS fixture: base index, PR overlay, merge', () => {
  let dir, base, overlay, merged;
  const node = (index, id) => index.nodes.find((n) => n.id === id);

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'dyffle-'));
    cpSync(join(fixture, 'base'), dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    base = buildBaseIndex({ root: dir });

    git(dir, 'checkout', '-qb', 'feature');
    cpSync(join(fixture, 'pr'), dir, { recursive: true });
    git(dir, 'rm', '-q', 'src/orders/orders.repository.ts');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'pr');
    overlay = buildOverlay({ root: dir, baseRef: 'main' });
    merged = merge(base, overlay);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('indexes modules from @Module metadata', () => {
    const users = base.modules.find((m) => m.id === 'src/users');
    assert.equal(users.name, 'UsersModule');
    assert.deepEqual(users.providers.map((p) => p.target), ['src/users/users.service.ts#UsersService']);
    assert.deepEqual(users.imports.map((i) => [i.name, i.dynamic, i.external]), [['TypeOrmModule', 'forFeature', true]]);
    const orders = base.modules.find((m) => m.id === 'src/orders');
    assert.deepEqual(orders.imports.map((i) => i.module), ['src/users']);
    assert.deepEqual(orders.providers[1], {
      token: 'src/orders/orders.service.ts#ORDERS_REPO',
      via: 'useClass',
      target: 'src/orders/orders.repository.ts#OrdersRepository',
    });
  });

  it('resolves exact references through barrels and path aliases', () => {
    const findOne = node(base, 'src/users/users.service.ts#UsersService.findOne');
    assert.deepEqual(findOne.references, [
      'src/orders/orders.service.ts#OrdersService.createForUser', // imported via the ../users barrel
      'src/reports/reports.service.ts#ReportsService.userSummary', // imported via the @app/* alias
      'src/users/users.controller.ts#UsersController.findOne',
      'src/users/users.service.spec.ts',
    ]);
    // References that only appear in type annotations are marked as such.
    const create = node(base, 'src/orders/orders.controller.ts#OrdersController.create');
    assert.deepEqual(create.typeUses, ['src/orders/dto/create-order.dto.ts#CreateOrderDto']);
    assert.ok(create.uses.includes('src/orders/orders.service.ts#OrdersService.createForUser'));
    // Same method name in another class is not confused with UsersService.findOne.
    assert.ok(!node(base, 'src/users/users.controller.ts#UsersController.findOne').references.length);
  });

  it('records routes, the global prefix and injections', () => {
    assert.equal(base.globalPrefix, 'api');
    assert.deepEqual(node(base, 'src/orders/orders.controller.ts#OrdersController.create').route, {
      type: 'http',
      verb: 'POST',
      path: ':userId',
      fullPath: '/orders/:userId',
    });
    const injects = node(base, 'src/orders/orders.service.ts#OrdersService.constructor').injects;
    assert.equal(injects[1].kind, 'token');
    assert.equal(injects[1].target, 'src/orders/orders.repository.ts#OrdersRepository');
    assert.equal(node(base, 'src/users/users.service.ts#UsersService.constructor').injects[0].kind, 'repository');
  });

  it('names GraphQL routes after the operation, not the return type', () => {
    const route = (m) => node(base, `src/users/users.resolver.ts#UsersResolver.${m}`).route;
    assert.deepEqual(route('findAll'), { type: 'graphql', verb: 'Query', path: 'users' });
    assert.deepEqual(route('findOne'), { type: 'graphql', verb: 'Query', path: 'user' });
    assert.deepEqual(route('rename'), { type: 'graphql', verb: 'Mutation', path: 'rename' });
  });

  it('marks symbols in the overlay as added, modified and removed', () => {
    assert.equal(overlay.kind, 'overlay');
    assert.equal(node(overlay, 'src/users/users.service.ts#UsersService.findByEmail').change.status, 'added');
    const findOne = node(overlay, 'src/users/users.service.ts#UsersService.findOne');
    assert.equal(findOne.change.status, 'modified');
    assert.equal(findOne.change.signatureChanged, true);
    assert.equal(findOne.change.previousSignature, 'async (id: number)');
    assert.equal(node(overlay, 'src/users/users.service.ts#UsersService.constructor').change, undefined);
    const removed = overlay.pr.deletedSymbols.map((s) => s.id);
    assert.ok(removed.includes('src/users/users.service.ts#UsersService.findAllLegacy'));
    assert.ok(removed.includes('src/orders/orders.repository.ts#OrdersRepository'));
    assert.deepEqual(overlay.pr.deletedFiles, ['src/orders/orders.repository.ts']);
    // Only changed files are indexed.
    assert.ok(!overlay.files.some((f) => f.path === 'src/reports/reports.service.ts'));
  });

  it('gives the same overlay from a pasted diff as from git', () => {
    const diff = execFileSync('git', ['diff', 'main...feature'], { cwd: dir, encoding: 'utf8' });
    const fromDiff = buildOverlay({ root: dir, diff });
    const strip = (o) => o.nodes.map((n) => [n.id, n.change?.status, n.change?.hunks.length]);
    assert.deepEqual(strip(fromDiff), strip(overlay));
    assert.deepEqual(fromDiff.pr.deletedSymbols.map((s) => s.id), overlay.pr.deletedSymbols.map((s) => s.id));
  });

  it("gives a file's own node only the lines no symbol holds: imports and top-level code", () => {
    const changed = (hunks) => hunks.flatMap((h) => h.lines.filter((l) => l.t !== ' ').map((l) => l.t + l.text.trim()));
    const lines = changed(node(merged, 'src/users/users.service.ts').change.hunks);
    assert.deepEqual(lines, ["+import * as bcrypt from 'bcrypt';"]);
    // The method changes stay with the methods.
    assert.ok(changed(merged.files.find((f) => f.path === 'src/users/users.service.ts').change.hunks).length > lines.length);
    assert.equal(node(merged, 'src/orders/orders.service.ts').change, undefined);
  });

  it('finds references the PR broke', () => {
    // A .json import is a use of a file dyffle never indexes; it is not broken.
    assert.ok(node(merged, 'src/reports/report-labels.ts#reportTitle').uses.includes('src/reports/report-labels.json'));
    assert.deepEqual(
      merged.checks.danglingReferences.map((d) => [d.from, d.to]),
      [
        ['src/orders/orders.module.ts#OrdersModule', 'src/orders/orders.repository.ts#OrdersRepository'],
        ['src/reports/reports.service.ts#ReportsService.exportUsers', 'src/users/users.service.ts#UsersService.findAllLegacy'],
      ],
    );
  });

  it('lists callers outside the PR for changed signatures', () => {
    const sig = merged.checks.signatureChanges.find((s) => s.id.endsWith('UsersService.findOne'));
    assert.deepEqual(sig.callersOutsidePr, ['src/reports/reports.service.ts#ReportsService.userSummary', 'src/users/users.service.spec.ts']);
    assert.ok(sig.callersInPr.includes('src/orders/orders.service.ts#OrdersService.createForUser'));
  });

  it('detects new module dependencies and cycles', () => {
    assert.deepEqual(merged.checks.newCycles, [['src/auth', 'src/users']]);
    assert.ok(
      merged.checks.newModuleDependencies.some((e) => e.from === 'src/users' && e.to === 'src/auth' && e.via === 'module-import' && e.forwardRef),
    );
    assert.ok(merged.modules.find((m) => m.id === 'src/common' && !m.declared));
  });

  it('follows callers up to affected routes', () => {
    const routes = Object.fromEntries(merged.checks.affectedRoutes.map((r) => [`${r.route.verb} ${r.route.fullPath}`, r.chain]));
    assert.deepEqual(routes['GET /reports/users/:id'], [
      'src/users/users.service.ts#UsersService.findOne',
      'src/reports/reports.service.ts#ReportsService.userSummary',
      'src/reports/reports.controller.ts#ReportsController.user',
    ]);
    assert.ok(routes['POST /orders/:userId']);
    assert.ok(routes['POST /auth/login']);
  });

  it('reports which changed code tests reach', () => {
    const findOne = merged.checks.tests.find((t) => t.id.endsWith('UsersService.findOne'));
    assert.deepEqual(findOne.testFiles, ['src/users/users.service.spec.ts']);
    assert.ok(merged.checks.untested.includes('src/users/users.service.ts#UsersService.findByEmail'));
  });

  it('reach gives the route chains and test files of an unchanged symbol', () => {
    const id = 'src/users/users.service.ts#UsersService.findOne';
    assert.equal(node(base, id).change, undefined);
    const { routes, testFiles } = reach(base, id);
    const route = routes.find((r) => r.route.fullPath === '/reports/users/:id');
    assert.equal(route.routeId, 'src/reports/reports.controller.ts#ReportsController.user');
    assert.equal(route.changed, id);
    assert.deepEqual(route.chain, [
      id,
      'src/reports/reports.service.ts#ReportsService.userSummary',
      'src/reports/reports.controller.ts#ReportsController.user',
    ]);
    assert.deepEqual(testFiles, ['src/users/users.service.spec.ts']);
  });

  it('reach works on an unchanged symbol of a merged index', () => {
    const id = 'src/reports/reports.service.ts#ReportsService.userSummary';
    assert.equal(node(merged, id).change, undefined);
    const { routes, testFiles } = reach(merged, id);
    assert.deepEqual(routes.map((r) => r.chain), [[id, 'src/reports/reports.controller.ts#ReportsController.user']]);
    assert.deepEqual(testFiles, []);
  });

  it('query: a changed symbol, with a signature change and untouched callers', () => {
    const id = 'src/users/users.service.ts#UsersService.findOne';
    const r = query(merged, 'UsersService.findOne');
    assert.deepEqual(r.node, { id, kind: 'method', file: 'src/users/users.service.ts', range: node(merged, id).range, signature: 'async (id: number, withOrders = false)' });
    assert.deepEqual(r.change, { status: 'modified', signatureChanged: true, previousSignature: 'async (id: number)' });
    assert.deepEqual(r.callers, {
      touched: ['src/orders/orders.service.ts#OrdersService.createForUser', 'src/users/users.controller.ts#UsersController.findOne'],
      untouched: ['src/reports/reports.service.ts#ReportsService.userSummary', 'src/users/users.service.spec.ts'],
    });
    assert.ok(r.routes.some((x) => x.route === 'GET /api/reports/users/:id' && x.chain.at(-1) === 'src/reports/reports.controller.ts#ReportsController.user'));
    assert.deepEqual(r.tests, ['src/users/users.service.spec.ts']);
    assert.deepEqual(r.broken, []);
    assert.ok(!JSON.stringify(r).includes('hunks'));
    assert.deepEqual(query(merged, id), r);
    assert.deepEqual(query(merged, id, { depth: 0 }).routes, []);
  });

  it('query: a removed symbol lists the references it broke', () => {
    const r = query(merged, 'UsersService.findAllLegacy');
    assert.deepEqual(r.change, { status: 'removed', signatureChanged: false });
    assert.deepEqual(r.broken, [{
      from: 'src/reports/reports.service.ts#ReportsService.exportUsers',
      to: 'src/users/users.service.ts#UsersService.findAllLegacy',
      file: 'src/reports/reports.service.ts',
      maybeRenamedTo: 'src/users/users.service.ts#UsersService.findByEmail',
    }]);
  });

  it('query: an unchanged symbol gets its routes and tests through reach, on a base index too', () => {
    const id = 'src/reports/reports.service.ts#ReportsService.userSummary';
    const r = query(merged, 'ReportsService.userSummary');
    assert.equal(r.change, null);
    assert.deepEqual(r.routes, [{ route: 'GET /api/reports/users/:id', chain: [id, 'src/reports/reports.controller.ts#ReportsController.user'] }]);
    assert.deepEqual(r.tests, []);
    assert.deepEqual(r.calls, ['src/users/users.service.ts#UsersService.findOne']);

    const onBase = query(base, 'UsersService.findOne');
    assert.equal(onBase.change, null);
    assert.deepEqual(onBase.tests, ['src/users/users.service.spec.ts']);
    assert.ok(onBase.routes.length);
  });

  it('query: calls leave out type-only uses', () => {
    const n = merged.nodes.find((x) => x.typeUses?.length && x.uses.length > x.typeUses.length);
    const r = query(merged, n.id);
    assert.deepEqual(r.calls, n.uses.filter((u) => !n.typeUses.includes(u)));
    for (const t of n.typeUses) assert.ok(!r.calls.includes(t));
  });

  it('query: a name that matches several nodes gives only candidates', () => {
    const r = query(merged, 'findOne');
    assert.deepEqual(Object.keys(r), ['candidates']);
    assert.deepEqual(r.candidates.map((c) => c.id), [
      'src/users/users.controller.ts#UsersController.findOne',
      'src/users/users.resolver.ts#UsersResolver.findOne',
      'src/users/users.service.ts#UsersService.findOne',
    ]);
    assert.deepEqual(r.candidates[0], { id: 'src/users/users.controller.ts#UsersController.findOne', kind: 'method', file: 'src/users/users.controller.ts' });
  });

  it('query: a class carries its members, where the routes and broken references are', () => {
    const r = query(merged, 'UsersService');
    assert.equal(r.node.kind, 'class');
    assert.deepEqual(r.routes, []);
    const legacy = r.members.find((m) => m.node.id.endsWith('.findAllLegacy'));
    assert.equal(legacy.broken.length, 1);
    assert.ok(r.members.find((m) => m.node.id.endsWith('.findOne')).routes.length);
    assert.equal(query(merged, 'UsersService.findOne').members, undefined);
  });

  it('query: a file gives its change, imports and the impact of its top-level nodes', () => {
    const path = 'src/users/users.service.ts';
    const r = query(merged, path);
    const f = merged.files.find((x) => x.path === path);
    assert.deepEqual(r.file, { path, change: { status: 'modified', additions: f.change.additions, deletions: f.change.deletions }, imports: f.imports });
    assert.deepEqual(r.symbols.map((s) => s.node.id), [path, `${path}#UsersService`]);
    const findOne = r.symbols[1].members.find((m) => m.node.id.endsWith('.findOne'));
    assert.equal(findOne.change.signatureChanged, true);
    assert.deepEqual(findOne.callers.untouched, query(merged, 'UsersService.findOne').callers.untouched);

    const gone = query(merged, 'src/orders/orders.repository.ts');
    assert.equal(gone.file.change.status, 'removed');
    assert.equal(gone.symbols[1].broken[0].from, 'src/orders/orders.module.ts#OrdersModule');

    const same = query(merged, 'src/reports/reports.service.ts');
    assert.equal(same.file.change, null);
    assert.ok(same.file.imports.length);
  });

  it('query: no target summarizes the branch from its checks', () => {
    const { summary, ...rest } = query(merged);
    assert.deepEqual(rest, {});
    const c = merged.checks;
    assert.deepEqual(summary.danglingReferences, c.danglingReferences);
    assert.deepEqual(summary.newModuleDependencies, c.newModuleDependencies);
    assert.deepEqual(summary.newCycles, c.newCycles);
    assert.deepEqual(summary.newFileCycles, c.newFileCycles);
    assert.deepEqual(summary.untested, c.untested);
    assert.deepEqual(summary.signatureChanges, [{
      id: 'src/users/users.service.ts#UsersService.findOne',
      before: 'async (id: number)',
      after: 'async (id: number, withOrders = false)',
      callersOutsidePr: ['src/reports/reports.service.ts#ReportsService.userSummary', 'src/users/users.service.spec.ts'],
    }]);
  });

  it('query: throws when nothing matches, and on a summary without checks', () => {
    assert.throws(() => query(merged, 'NoSuchThing'), /Nothing in the index matches "NoSuchThing"/);
    assert.throws(() => query(merged, ''), /Nothing in the index matches/);
    assert.throws(() => query(base), /needs a merged index, got a "base" index/);
  });

  describe('dyffle query', () => {
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [cli, 'query', ...args], { cwd: dir, encoding: 'utf8' });
    const ok = (...args) => {
      const r = run(...args);
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    const fails = (...args) => {
      const r = run(...args);
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '');
      return r.stderr;
    };
    const findOne = 'src/users/users.service.ts#UsersService.findOne';
    let file;

    before(() => {
      file = join(dir, 'merged.json');
      writeFileSync(file, JSON.stringify(merged));
    });

    it('prints a node as short Markdown: callers untouched first, routes as chains', () => {
      const md = ok('UsersService.findOne', '--index', file);
      assert.equal(md, queryMarkdown(query(merged, 'UsersService.findOne')));
      assert.ok(md.startsWith(`## \`${findOne}\`\n\nmethod, lines `));
      assert.ok(md.includes('**Change:** modified, signature changed (was `async (id: number)`)'));
      assert.ok(md.indexOf('**Callers, untouched (2):**') < md.indexOf('**Callers, touched too (2):**'));
      assert.ok(md.includes('- **GET /api/reports/users/:id** via `UsersService.findOne` → `ReportsService.userSummary` → `ReportsController.user`'));
      assert.ok(md.includes('**Tests (1):**\n- `src/users/users.service.spec.ts`'));
      assert.ok(md.includes('**None:** broken references.'));
      assert.ok(!md.includes('hunks'));
    });

    it('--json prints the QueryResult, for each shape', () => {
      const same = (...target) => assert.deepEqual(JSON.parse(ok(...target, '--index', file, '--json')), query(merged, ...target));
      same('UsersService.findOne');
      same('UsersService');
      same('findOne');
      same('src/users/users.service.ts');
      same();
      assert.deepEqual(JSON.parse(ok('UsersService.findOne', '--index', file, '--json', '--depth', '0')).routes, []);
    });

    it('prints the other shapes as Markdown', () => {
      const candidates = ok('findOne', '--index', file);
      assert.ok(candidates.startsWith('**Several nodes match, query one by id (3):**\n- `src/users/users.controller.ts#UsersController.findOne` (method)\n'));

      const summary = ok('--index', file);
      assert.ok(summary.startsWith('## Branch summary\n'));
      assert.ok(summary.includes('**Broken references ('));
      assert.ok(summary.includes(`\`${findOne}\`: \`async (id: number)\` → \`async (id: number, withOrders = false)\`. Check \`src/reports/reports.service.ts#ReportsService.userSummary\``));

      const whole = ok('src/users/users.service.ts', '--index', file);
      assert.ok(whole.startsWith('## `src/users/users.service.ts`\n\n**Change:** modified, +'));
      assert.ok(whole.includes('**Imports:** '));
      assert.ok(whole.includes('### `UsersService.findOne`'));
    });

    it('keeps a class short: each member only shows what it has', () => {
      const md = ok('UsersService', '--index', file);
      assert.ok(md.includes('### `UsersService.findOne`\n\n- method, lines '));
      assert.ok(md.includes('### `UsersService.findAllLegacy`'));
      assert.ok(md.includes('- **Broken references (1):** '));
      // A class's routes are on its methods: no "none" line to say otherwise, and no empty sections.
      assert.ok(!md.includes('**None:**'));
      assert.ok(!md.includes('(0)'));
    });

    it('caps long lists and says how many are left', () => {
      const r = query(merged, 'UsersService.findOne');
      const untouched = Array.from({ length: 30 }, (_, i) => `src/a.ts#c${i}`);
      const md = queryMarkdown({ ...r, callers: { touched: [], untouched } });
      assert.ok(md.includes('**Callers, untouched (30):**\n- `src/a.ts#c0`'));
      assert.ok(md.includes('- `src/a.ts#c24`\n- …and 5 more\n'));
      assert.ok(!md.includes('c25'));
    });

    it('takes ./ and absolute paths under the root', () => {
      const path = 'src/users/users.service.ts';
      const want = ok(path, '--index', file, '--json');
      assert.equal(ok(`./${path}`, '--index', file, '--json'), want);
      assert.equal(ok(join(dir, path), '--index', file, '--json'), want);
      assert.equal(ok(join(dir, path), '--index', file, '--json', '--root', dir), want);
      assert.equal(ok(`./${findOne}`, '--index', file, '--json'), ok(findOne, '--index', file, '--json'));
      assert.equal(ok(`${join(dir, findOne)}`, '--index', file, '--json'), ok(findOne, '--index', file, '--json'));
      assert.match(fails('/somewhere/else.ts', '--index', file), /Nothing in the index matches "\/somewhere\/else\.ts"/);
    });

    it('reads .dyffle/live.json under --root when there is no --index', () => {
      const root = mkdtempSync(join(tmpdir(), 'dyffle-query-'));
      try {
        assert.match(fails('--root', root), /No index to query: .*\.dyffle\/live\.json does not exist\. Pass --index <merged\.json>, or run "dyffle watch/);
        mkdirSync(join(root, '.dyffle'));
        writeFileSync(join(root, '.dyffle', 'live.json'), JSON.stringify(merged));
        assert.equal(ok('UsersService.findOne', '--root', root), ok('UsersService.findOne', '--index', file));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('turns what query throws, and bad input, into clear errors', () => {
      assert.equal(fails('NoSuchThing', '--index', file), 'dyffle: Nothing in the index matches "NoSuchThing"\n');
      const baseFile = join(dir, 'base.json');
      writeFileSync(baseFile, JSON.stringify(base));
      assert.equal(fails('--index', baseFile), 'dyffle: A branch summary needs a merged index, got a "base" index\n');
      assert.match(fails('x', '--index', join(dir, 'nope.json')), /No index at .*nope\.json/);
      writeFileSync(join(dir, 'other.json'), '{}');
      assert.match(fails('x', '--index', join(dir, 'other.json')), /is not a dyffle index/);
      writeFileSync(join(dir, 'other.json'), '{"nodes":');
      assert.match(fails('x', '--index', join(dir, 'other.json')), /is not a dyffle index/);
      assert.match(fails('UsersService', '--index', file, '--depth', 'x'), /--depth takes a whole number/);
      assert.match(fails('a', 'b', '--index', file), /Pass one target/);

      // A target works on a base index, with a note that it can't know about changes.
      const onBase = run('UsersService.findOne', '--index', baseFile);
      assert.equal(onBase.status, 0);
      assert.match(onBase.stderr, /"base" index/);
    });

    it('says plainly when a changed file is one the indexer skips', () => {
      const withSkipped = join(dir, 'skipped.json');
      const pr = { ...merged.pr, unindexedFiles: [{ path: 'README.md', status: 'modified', additions: 3, deletions: 1, hunks: [] }] };
      writeFileSync(withSkipped, JSON.stringify({ ...merged, pr }));
      for (const target of ['README.md', './README.md']) {
        assert.equal(
          fails(target, '--index', withSkipped),
          "dyffle: README.md changed on this branch (modified, +3 −1), but dyffle doesn't index that file, so it has no symbols or callers to show.\n",
        );
      }
    });
  });

  it('keeps the base-side imports of changed files', () => {
    const file = (p) => merged.files.find((f) => f.path === p);
    const resolved = (imports) => imports.map((i) => i.resolved).filter(Boolean);
    const app = file('src/app.module.ts');
    assert.ok(resolved(app.imports).includes('src/auth/auth.module.ts'));
    assert.ok(!resolved(app.change.previousImports).includes('src/auth/auth.module.ts'));
    assert.deepEqual(file('src/orders/orders.repository.ts').change.previousImports, []);
    assert.equal(file('src/auth/auth.module.ts').change.previousImports, undefined);
    assert.equal(file('src/reports/reports.service.ts').change, undefined);
  });

  it('keeps unchanged nodes from the base and recomputes references', () => {
    const findByEmail = node(merged, 'src/users/users.service.ts#UsersService.findByEmail');
    assert.deepEqual(findByEmail.references, ['src/auth/auth.service.ts#AuthService.validateUser']);
    assert.ok(node(merged, 'src/reports/reports.controller.ts#ReportsController.users'));
    assert.equal(node(merged, 'src/users/users.service.ts#UsersService.findAllLegacy').change.status, 'removed');
  });

  it('draws a Mermaid module map with new and circular edges', () => {
    const map = mermaidModuleMap(merged);
    assert.match(map, /^```mermaid\nflowchart LR/);
    assert.match(map, /AuthModule<\/b><br\/>src\/auth · \+\d+ −0"\]:::added/);
    assert.match(map, /ReportsModule<\/b><br\/>src\/reports · uses changed code"\]:::affected/);
    assert.match(map, /-->\|forwardRef\|/);
    assert.match(map, /linkStyle \d+ stroke:#B83A33,stroke-width:2.5px/);
    assert.match(markdownReport(merged, { map: true, link: 'https://example.com/run' }), /```mermaid[\s\S]*Open the interactive PR map\]\(https:\/\/example.com\/run\)|Open the interactive PR map[\s\S]*```mermaid/);
  });

  it('embeds the report in a PR description and replaces it on later runs', () => {
    const first = embedSection('My description\n', 'report v1');
    assert.equal(first, 'My description\n\n---\n\n<!-- dyffle:start -->\nreport v1\n<!-- dyffle:end -->\n');
    const edited = first + '\nA note added later';
    assert.equal(embedSection(edited, 'report v2'), edited.replace('report v1', 'report v2'));
    assert.equal(embedSection('', 'r'), '<!-- dyffle:start -->\nr\n<!-- dyffle:end -->\n');
    // Markers mentioned inline are not section boundaries.
    const mention = 'Sits between `<!-- dyffle:start -->` / `<!-- dyffle:end -->`.';
    assert.equal(embedSection(mention, 'r'), mention + '\n\n---\n\n<!-- dyffle:start -->\nr\n<!-- dyffle:end -->\n');
    // Descriptions edited on github.com use CRLF line endings.
    const crlf = 'Intro\r\n\r\n<!-- dyffle:start -->\r\nold\r\n<!-- dyffle:end -->\r\nOutro';
    assert.equal(embedSection(crlf, 'new'), 'Intro\r\n\r\n<!-- dyffle:start -->\nnew\n<!-- dyffle:end -->\r\nOutro');
    // A section from before the rename to dyffle is replaced, not duplicated.
    const old = 'Intro\n\n<!-- dyff:start -->\nold\n<!-- dyff:end -->\nOutro';
    assert.equal(embedSection(old, 'new'), 'Intro\n\n<!-- dyffle:start -->\nnew\n<!-- dyffle:end -->\nOutro');
  });

  it('exports the viewer as one self-contained HTML file', () => {
    const html = standaloneHtml(merged);
    assert.match(html, /<script>window\.DYFFLE_DATA = \{/);
    assert.ok(!html.slice(html.indexOf('DYFFLE_DATA'), html.indexOf('</script>', html.indexOf('DYFFLE_DATA'))).includes('<'));
  });

  it('serves several merged indexes to switch between', async () => {
    assert.match(standaloneHtml([{ label: 'a', index: merged }, { label: 'b', index: merged }]), /<script>window\.DYFFLE_LIST = \[\{"label":"a","index":\{/);
    const { server, url } = await serve([{ label: 'one', index: '{"n":1}' }, { label: 'two', index: '{"n":2}' }], { port: 0 });
    try {
      const get = async (p) => { const r = await fetch(url + p); return r.ok ? r.json() : r.status; };
      assert.deepEqual(await get('indexes.json'), ['one', 'two']);
      assert.deepEqual(await get('index.json'), { n: 1 });
      assert.deepEqual(await get('index.json?i=1'), { n: 2 });
      assert.equal(await get('index.json?i=2'), 404);
    } finally {
      server.close();
    }
  });

  it('writes a markdown report', () => {
    const md = markdownReport(merged);
    assert.match(md, /This PR breaks 2 references/);
    assert.match(md, /GET \/api\/reports\/users\/:id/);
    assert.match(md, /`src\/auth` ⇄ `src\/users`/);
  });
});

describe('reach', () => {
  const route = { verb: 'GET', path: '/x', fullPath: '/x' };
  // a <- b <- c (route) <- d (test). t uses a as a type only, and t2 (a route) uses b as a type only.
  const nodes = [
    { id: 'a', file: 'a.ts', references: ['b', 't'] },
    { id: 'b', file: 'b.ts', references: ['c', 't2'] },
    { id: 'c', file: 'c.ts', references: ['d'], route },
    { id: 'd', file: 'd.spec.ts', references: [], test: true },
    { id: 't', file: 't.ts', references: ['tr'], typeUses: ['a'] },
    { id: 'tr', file: 'tr.ts', references: [], route },
    { id: 't2', file: 't2.ts', references: [], typeUses: ['b'], route },
  ];
  const index = { nodes };
  const chains = (r) => r.routes.map((x) => x.chain.join('>'));

  it('follows a type-only reference one step from the start node, and no further', () => {
    assert.deepEqual(chains(reach(index, 'a')), ['a>b>c']);
    assert.deepEqual(chains(reach(index, 't')), ['t>tr']);
    assert.deepEqual(chains(reach(index, 'b')), ['b>c', 'b>t2']);
  });

  it('stops at the depth limit', () => {
    assert.deepEqual(reach(index, 'a', { depth: 1 }), { routes: [], testFiles: [] });
    assert.deepEqual(chains(reach(index, 'a', { depth: 2 })), ['a>b>c']);
    assert.deepEqual(reach(index, 'a', { depth: 2 }).testFiles, []);
    assert.deepEqual(reach(index, 'a', { depth: 3 }).testFiles, ['d.spec.ts']);
  });

  it('gives the same result with a prepared graph', () => {
    assert.deepEqual(reach(index, 'a', { graph: reachGraph(index) }), reach(index, 'a'));
  });

  it('throws on a node that is not in the index', () => {
    assert.throws(() => reach(index, 'nope'), /Unknown node "nope"/);
  });
});

describe('cycles that exist before the PR', () => {
  let dir;
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('does not report an existing cycle as new when the PR removes one of its modules', () => {
    dir = mkdtempSync(join(tmpdir(), 'dyffle-'));
    const write = (path, text) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    const feature = (name) =>
      [
        "import { Module } from '@nestjs/common';",
        "import { SharedEntity } from '../shared.entity';",
        `export const ${name}Entities = [SharedEntity];`,
        '@Module({})',
        `export class ${name}Module {}`,
        '',
      ].join('\n');
    const app = (names) =>
      [
        "import { Module } from '@nestjs/common';",
        ...names.map((n) => `import { ${n}Module } from './${n.toLowerCase()}/${n.toLowerCase()}.module';`),
        `@Module({ imports: [${names.map((n) => `${n}Module`).join(', ')}] })`,
        'export class AppModule {}',
        '',
      ].join('\n');
    cpSync(join(fixture, 'base', 'tsconfig.json'), join(dir, 'tsconfig.json'));
    write('src/shared.entity.ts', 'export class SharedEntity {}\n');
    for (const n of ['A', 'B', 'C']) write(`src/${n.toLowerCase()}/${n.toLowerCase()}.module.ts`, feature(n));
    write('src/app.module.ts', app(['A', 'B', 'C']));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    const base = buildBaseIndex({ root: dir });

    git(dir, 'checkout', '-qb', 'feature');
    git(dir, 'rm', '-rq', 'src/c');
    write('src/app.module.ts', app(['A', 'B']));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'pr');
    const merged = merge(base, buildOverlay({ root: dir, baseRef: 'main' }));

    assert.deepEqual(merged.checks.cycles, [['src', 'src/a', 'src/b']]);
    assert.deepEqual(merged.checks.newCycles, []);
  });
});

describe('circular file imports', () => {
  let dir;
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('finds new and existing cycles, follows renames and skips type-only imports', () => {
    dir = mkdtempSync(join(tmpdir(), 'dyffle-'));
    const write = (path, text) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    cpSync(join(fixture, 'base', 'tsconfig.json'), join(dir, 'tsconfig.json'));
    write('src/a.ts', "import { b } from './b';\nexport const a = () => b;\n");
    write('src/b.ts', "import { a } from './a';\nexport const b = () => a;\n");
    write('src/c.ts', 'export const c = 1;\n');
    write('src/d.ts', "import { c } from './c';\nexport const d = c;\n");
    write('src/e.ts', "import type { F } from './f';\nexport type E = { f?: F };\n");
    write('src/f.ts', "import { E } from './e';\nexport type F = { e?: E };\nexport const f = 1;\n");
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    const base = buildBaseIndex({ root: dir });

    git(dir, 'checkout', '-qb', 'feature');
    git(dir, 'mv', 'src/b.ts', 'src/b2.ts');
    write('src/a.ts', "import { b } from './b2';\nexport const a = () => b;\n");
    write('src/c.ts', "import { d } from './d';\nexport const c = 1;\nexport const cd = () => d;\n");
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'pr');
    const merged = merge(base, buildOverlay({ root: dir, baseRef: 'main' }));

    assert.deepEqual(merged.checks.fileCycles, [['src/a.ts', 'src/b2.ts'], ['src/c.ts', 'src/d.ts']]);
    assert.deepEqual(merged.checks.newFileCycles, [['src/c.ts', 'src/d.ts']]);
    assert.match(markdownReport(merged), /New circular file imports[\s\S]*src\/c\.ts/);
  });
});

describe('files with syntax errors', () => {
  it('indexes a file whose import has no string specifier', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dyffle-'));
    try {
      writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(dir, 'b.ts'), "import { a } from ./a';\nexport const b = a;\n");
      const index = buildBaseIndex({ root: dir });
      assert.deepEqual(index.files.map((f) => f.path), ['a.ts', 'b.ts']);
      assert.deepEqual(index.files[1].imports, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Vue fixture: single-file components and vue-router routes', () => {
  let dir, base, merged;
  const node = (index, id) => index.nodes.find((n) => n.id === id);

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'dyffle-'));
    cpSync(join(vueFixture, 'base'), dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    base = buildBaseIndex({ root: dir });

    git(dir, 'checkout', '-qb', 'feature');
    cpSync(join(vueFixture, 'pr'), dir, { recursive: true });
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'pr');
    merged = merge(base, buildOverlay({ root: dir, baseRef: 'main' }));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('indexes script setup declarations at their line in the .vue file', () => {
    assert.deepEqual(node(base, 'src/views/OrdersView.vue#refresh').range, [7, 9]);
    assert.deepEqual(node(base, 'src/views/OrdersView.vue').range, [1, 21]);
  });

  it('query: a .vue file with no symbols keeps its callers and routes on the file node', () => {
    const r = query(merged, 'src/components/OrderRow.vue');
    assert.deepEqual(r.symbols.map((s) => s.node.id), ['src/components/OrderRow.vue']);
    assert.deepEqual(r.symbols[0].callers.untouched, ['src/views/OrderDetail.vue']);
    assert.deepEqual(r.symbols[0].callers.touched, ['src/views/OrdersView.vue']);
    assert.equal(r.symbols[0].routes.length, 2);
  });

  it('links components and functions the template uses, and imports of .vue files through aliases', () => {
    assert.deepEqual(node(base, 'src/components/OrderRow.vue').references, ['src/views/OrderDetail.vue', 'src/views/OrdersView.vue']);
    assert.deepEqual(node(base, 'src/composables/useOrders.ts#formatTotal').references, ['src/components/OrderRow.vue']);
    assert.ok(node(base, 'src/views/OrdersView.vue').uses.includes('src/views/OrdersView.vue#refresh'));
  });

  it('turns vue-router records into page routes, with nested and lazily loaded components', () => {
    const routes = base.nodes.filter((n) => n.kind === 'route').map((n) => [n.route.fullPath, n.uses]);
    assert.deepEqual(routes, [
      ['/orders', ['src/views/OrdersView.vue']],
      ['/orders/:id', ['src/views/OrderDetail.vue']],
    ]);
  });

  it("gives a .vue file's template and styles a diff of their own", () => {
    const file = merged.files.find((f) => f.path === 'src/views/OrdersView.vue');
    assert.deepEqual(
      file.change.sections.map((x) => [x.name, x.hunks.flatMap((h) => h.lines.filter((l) => l.t !== ' ').map((l) => l.t + l.text.trim()))]),
      [['template', ['-<h1>Orders</h1>', '+<h1>Your orders</h1>']]],
    );
    // The template is not the script's top-level code.
    assert.deepEqual(node(merged, 'src/views/OrdersView.vue').change.hunks, []);
  });

  it('follows changed composables and template-only changes up to the pages', () => {
    const view = node(merged, 'src/views/OrdersView.vue');
    assert.equal(view.change.status, 'modified');
    assert.equal(node(merged, 'src/views/OrdersView.vue#refresh').change, undefined);
    const sig = merged.checks.signatureChanges.find((s) => s.id === 'src/composables/useOrders.ts#formatTotal');
    assert.deepEqual(sig.callersOutsidePr, ['src/components/OrderRow.vue']);
    assert.deepEqual(
      merged.checks.affectedRoutes.map((r) => [r.route.fullPath, r.chain]),
      [
        ['/orders', ['src/views/OrdersView.vue', 'src/router/index.ts#/orders']],
        ['/orders/:id', ['src/composables/useOrders.ts#formatTotal', 'src/components/OrderRow.vue', 'src/views/OrderDetail.vue', 'src/router/index.ts#/orders/:id']],
      ],
    );
  });
});

describe('rebase', () => {
  it('turns a merged index into a base index of the PR head', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dyffle-'));
    try {
      cpSync(join(fixture, 'base'), dir, { recursive: true });
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'base');
      const base = buildBaseIndex({ root: dir });
      git(dir, 'checkout', '-qb', 'feature');
      cpSync(join(fixture, 'pr'), dir, { recursive: true });
      git(dir, 'rm', '-q', 'src/orders/orders.repository.ts');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'pr');
      const merged = merge(base, buildOverlay({ root: dir, baseRef: 'main' }));
      const rebased = rebase(merged, 'abc');
      const fresh = buildBaseIndex({ root: dir });
      assert.equal(rebased.kind, 'base');
      assert.equal(rebased.commit, 'abc');
      assert.equal(rebased.pr, undefined);
      assert.equal(rebased.checks, undefined);
      assert.ok(!rebased.nodes.some((n) => n.change) && !rebased.files.some((f) => f.change));
      assert.deepEqual(rebased.files.map((f) => f.path), fresh.files.map((f) => f.path));
      assert.deepEqual(rebased.nodes.map((n) => [n.id, n.references]), fresh.nodes.map((n) => [n.id, n.references]));
      // Usable as the base of the next change.
      assert.equal(merge(rebased, buildOverlay({ root: dir, diff: '' })).checks.summary.filesChanged, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dyffle watch', () => {
  let dir, session;
  const inbox = (name, body) => writeFileSync(join(dir, '.dyffle/inbox', name), typeof body === 'string' ? body : JSON.stringify(body));
  const feed = () => JSON.parse(session.feed());

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dyffle-'));
    cpSync(join(fixture, 'base'), dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    git(dir, 'checkout', '-qb', 'feature');
    // Already on the branch before watch starts: part of the branch dyffle, not of any post.
    appendFileSync(join(dir, 'src/main.ts'), '\nexport const early = 1;\n');
    writeFileSync(join(dir, 'src/extra.ts'), 'export const extra = 2;\n');
    session = new LiveSession({ root: dir, baseRef: 'main', interval: 50 });
    await session.start();
    await session.stop();
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('starts with a dyffle of the whole branch, untracked files included', async () => {
    await session.tick();
    const live = JSON.parse(session.index(0));
    assert.deepEqual(live.pr.changedFiles.sort(), ['src/extra.ts', 'src/main.ts']);
    assert.deepEqual(session.labels(), ['Branch (live)']);
    assert.ok(!git(dir, 'status', '--porcelain').includes('.dyffle'));
    assert.equal(git(dir, 'diff', '--cached', '--name-only'), '');
  });

  it('rebuilds the branch dyffle when a file changes', async () => {
    const before = session.index(0);
    await session.tick();
    assert.equal(session.index(0), before);
    const file = join(dir, 'src/orders/orders.service.ts'), text = readFileSync(file, 'utf8');
    appendFileSync(file, '\nexport function helper() {}\n');
    await session.tick();
    const live = JSON.parse(session.index(0));
    assert.ok(live.nodes.some((n) => n.id === 'src/orders/orders.service.ts#helper' && n.change?.status === 'added'));
    writeFileSync(file, text);
    await session.tick();
    assert.ok(!JSON.parse(session.index(0)).pr.changedFiles.includes('src/orders/orders.service.ts'));
  });

  it('posts a message without a change', async () => {
    inbox('a.json', { message: 'Just a **question**' });
    await session.tick();
    const [p] = feed().posts;
    assert.equal(p.id, 1);
    assert.equal(p.author, 'claude');
    assert.equal(p.dyffle, undefined);
    assert.equal(p.index, undefined);
    assert.equal(readdirSync(join(dir, '.dyffle/inbox')).length, 0);
    assert.ok(existsSync(join(dir, '.dyffle/posts/0001.json')));
  });

  it('attaches what changed since watch started, then since the previous post', async () => {
    cpSync(join(fixture, 'pr/src/auth'), join(dir, 'src/auth'), { recursive: true });
    inbox('b.json', { title: 'Auth', message: 'Added auth', change: true });
    await session.tick();
    const p2 = feed().posts[1];
    assert.equal(p2.index, 1);
    const d2 = JSON.parse(session.index(1));
    assert.equal(d2.pr.title, 'Auth');
    assert.equal(d2.pr.headCommit, p2.snapshot);
    // Not main.ts or extra.ts: those changed before.
    assert.ok(d2.pr.changedFiles.every((f) => f.startsWith('src/auth/')), d2.pr.changedFiles.join());
    assert.equal(git(dir, 'rev-parse', 'refs/dyffle/posts/2').trim(), p2.snapshot);

    cpSync(join(fixture, 'pr/src/users/users.service.ts'), join(dir, 'src/users/users.service.ts'));
    inbox('c.json', { message: 'Users', change: true });
    await session.tick();
    const p3 = feed().posts[2];
    assert.equal(p3.from, p2.snapshot);
    assert.deepEqual(JSON.parse(session.index(2)).pr.changedFiles, ['src/users/users.service.ts']);
    assert.deepEqual(session.labels(), ['Branch (live)', '#2 Auth', '#3 Users']);
    // The branch dyffle follows along.
    assert.ok(JSON.parse(session.index(0)).pr.changedFiles.includes('src/users/users.service.ts'));

    inbox('d.json', { message: 'Again', change: true });
    await session.tick();
    assert.equal(feed().posts[3].note, 'Nothing changed since the previous post.');
  });

  it('rejects invalid posts with an .error file', async () => {
    inbox('bad.json', { message: '' });
    await session.tick();
    assert.match(readFileSync(join(dir, '.dyffle/inbox/bad.error'), 'utf8'), /message/);
    assert.throws(() => readPostInput({ message: 'x', change: 'yes' }), /change/);
  });

  it('serves the feed and streams changes', async () => {
    const { server, url } = await serve(session, { port: 0 });
    try {
      assert.equal((await (await fetch(url + 'feed.json')).json()).posts.length, 4);
      assert.deepEqual(await (await fetch(url + 'indexes.json')).json(), session.labels());
      const res = await fetch(url + 'events');
      const reader = res.body.getReader();
      await reader.read();
      inbox('e.json', { message: 'Hello' });
      await session.tick();
      let text = '';
      while (!text.includes('event: feed')) text += new TextDecoder().decode((await reader.read()).value);
      assert.match(text, /event: feed\ndata: \{"id":5\}/);
      await reader.cancel();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('keeps reviews of the live branch and of posts, and lists them as Markdown', async () => {
    const { server, url } = await serve(session, { port: 0 });
    try {
      assert.deepEqual(await (await fetch(url + 'review.json?key=post-2')).json(), { key: 'post-2', body: '', comments: [], viewed: {} });
      assert.equal((await fetch(url + 'review.json?key=../x')).status, 404);
      const events = await fetch(url + 'events');
      const reader = events.body.getReader();
      await reader.read();
      const comment = { id: 'a', path: 'src/auth/auth.service.ts', line: 1, side: 'RIGHT', body: 'Why?', code: 'import x;', symbol: 'src/auth/auth.service.ts#AuthService', created: 1 };
      const put = await fetch(url + 'review.json?key=post-2&client=me', { method: 'PUT', body: JSON.stringify({ body: 'Looks good', comments: [comment], viewed: { 'src/auth/auth.service.ts': 'h1' } }) });
      assert.equal(put.status, 204);
      let text = '';
      while (!text.includes('event: review')) text += new TextDecoder().decode((await reader.read()).value);
      assert.match(text, /"key":"post-2","client":"me","comments":1/);
      await reader.cancel();
      const stored = JSON.parse(readFileSync(join(dir, '.dyffle/reviews/post-2.json'), 'utf8'));
      assert.equal(stored.post, 2);
      assert.equal(stored.title, 'Auth');
      assert.equal(stored.headCommit, feed().posts[1].snapshot);
      assert.deepEqual(stored.viewed, { 'src/auth/auth.service.ts': 'h1' });
      assert.equal(feed().posts[1].comments, 1);
      // A message-only post has no review, and bad input is refused.
      assert.equal((await fetch(url + 'review.json?key=post-1', { method: 'PUT', body: JSON.stringify({ body: '', comments: [] }) })).status, 400);
      assert.equal((await fetch(url + 'review.json?key=live', { method: 'PUT', body: '{"body":1}' })).status, 400);
      assert.throws(() => readReviewInput({ body: '', comments: [{ id: 'x', path: 'a', line: 1, side: 'UP', body: '' }] }), /side/);

      const main = readFileSync(join(dir, 'src/main.ts'), 'utf8').split('\n');
      session.saveReview('live', JSON.stringify({ body: '', comments: [
        { id: 'b', path: 'src/main.ts', line: 1, side: 'RIGHT', body: 'Still here', code: main[0], created: 2 },
        { id: 'c', path: 'src/main.ts', line: 2, side: 'RIGHT', body: 'Was here', code: 'something else', created: 3 },
      ], viewed: {} }));
      const md = reviewsMarkdown(dir);
      assert.match(md, /## Post #2: Auth\n\nLooks good\n\n- \*\*src\/auth\/auth\.service\.ts:1 in `AuthService`\*\*\n/);
      assert.match(md, /## Whole branch \(live\)/);
      assert.match(md, /src\/main\.ts:1\*\*\n/);
      assert.match(md, /src\/main\.ts:2\*\* \(outdated: the line changed since\)/);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('serves files as the dyffle they are in shows them', async () => {
    const p2 = feed().posts[1];
    const atPost = git(dir, 'show', `${p2.snapshot}:src/auth/auth.service.ts`);
    assert.equal(JSON.parse(session.source('post-2', 'src/auth/auth.service.ts')).text, atPost);
    // The live branch serves its own tree: an edit since the last rebuild doesn't show yet.
    const file = join(dir, 'src/users/users.service.ts'), text = readFileSync(file, 'utf8');
    appendFileSync(file, '\n// not yet\n');
    assert.equal(JSON.parse(session.source('live', 'src/users/users.service.ts')).text, text);
    writeFileSync(file, text);
    // Unchanged files too, but nothing outside the dyffle, and no unknown or message-only posts.
    assert.ok(JSON.parse(session.source('live', 'src/main.ts')).text.includes('bootstrap'));
    for (const [key, path] of [['live', '../outside.ts'], ['live', '.dyffle/state.json'], ['live', 'tsconfig.json'], ['post-1', 'src/main.ts'], ['post-99', 'src/main.ts'], ['x', 'src/main.ts']])
      assert.equal(session.source(key, path), undefined, `${key} ${path}`);
    const { server, url } = await serve(session, { port: 0 });
    try {
      assert.equal((await (await fetch(url + 'source.json?key=post-2&path=src/auth/auth.service.ts')).json()).text, atPost);
      assert.equal((await fetch(url + 'source.json?key=live&path=../x')).status, 404);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('picks up posts and state again after a restart', async () => {
    const again = new LiveSession({ root: dir, baseRef: 'main' });
    await again.start();
    await again.stop();
    assert.equal(JSON.parse(again.feed()).posts.length, 5);
    assert.equal(again.labels().length, 3);
  });
});

describe('pausing and resuming a session', () => {
  let dir;
  const start = async (log) => {
    const session = new LiveSession({ root: dir, baseRef: 'main', interval: 20, log });
    await session.start();
    return session;
  };
  const posts = (session) => JSON.parse(session.feed()).posts;
  /** Post through the inbox, as `dyffle post` does, and let the session's own loop take it in. */
  const post = async (session, name, body) => {
    const count = posts(session).length;
    writeFileSync(join(dir, '.dyffle/inbox', `${name}.json`), JSON.stringify(body));
    const deadline = Date.now() + 30000;
    while (posts(session).length === count) {
      assert.ok(Date.now() < deadline, `post ${name} was not taken in`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return posts(session).at(-1);
  };
  const add = (file, name) => writeFileSync(join(dir, file), `export const ${name} = 1;\n`);
  const changedFiles = (session, i) => JSON.parse(session.index(i)).pr.changedFiles;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'dyffle-'));
    cpSync(join(fixture, 'base'), dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    git(dir, 'checkout', '-qb', 'feature');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps the posts and measures the next change from the previous post', async () => {
    const first = await start();
    let p1;
    try {
      const startSnapshot = git(dir, 'rev-parse', 'refs/dyffle/start').trim();
      add('src/first.ts', 'first');
      p1 = await post(first, 'a', { title: 'First', message: 'One', change: true });
      assert.equal(p1.from, startSnapshot);
      assert.deepEqual(changedFiles(first, 1), ['src/first.ts']);
    } finally {
      await first.stop();
    }
    const startRef = git(dir, 'rev-parse', 'refs/dyffle/start').trim();
    const stored = readFileSync(join(dir, '.dyffle/posts/0001.json'), 'utf8');

    // Made while paused, so a new start snapshot would have a different tree and swallow this edit.
    add('src/paused.ts', 'paused');
    const logged = [];
    const second = await start((m) => logged.push(m));
    try {
      assert.equal(git(dir, 'rev-parse', 'refs/dyffle/start').trim(), startRef);
      assert.equal(JSON.parse(readFileSync(join(dir, '.dyffle/state.json'), 'utf8')).snapshot, p1.snapshot);
      assert.deepEqual(second.labels(), ['Branch (live)', '#1 First']);
      assert.equal(posts(second)[0].snapshot, p1.snapshot);
      assert.deepEqual(changedFiles(second, 1), ['src/first.ts']);
      assert.ok(!logged.some((m) => m.startsWith('Indexing')), logged.join('\n'));
      assert.deepEqual(changedFiles(second, 0).sort(), ['src/first.ts', 'src/paused.ts']);

      const p2 = await post(second, 'b', { title: 'Second', message: 'Two', change: true });
      assert.equal(p2.id, 2);
      assert.equal(p2.from, p1.snapshot);
      assert.deepEqual(changedFiles(second, 2), ['src/paused.ts']);
      assert.equal(readFileSync(join(dir, '.dyffle/posts/0001.json'), 'utf8'), stored);
    } finally {
      await second.stop();
    }
  });

  it('takes in a post queued while paused', async () => {
    const from = JSON.parse(readFileSync(join(dir, '.dyffle/state.json'), 'utf8')).snapshot;
    add('src/queued.ts', 'queued');
    writeFileSync(join(dir, '.dyffle/inbox/c.json'), JSON.stringify({ message: 'Three', change: true }));
    const third = await start();
    try {
      const deadline = Date.now() + 30000;
      while (posts(third).length < 3) {
        assert.ok(Date.now() < deadline, 'queued post was not taken in');
        await new Promise((r) => setTimeout(r, 20));
      }
      const p3 = posts(third)[2];
      assert.equal(p3.id, 3);
      assert.equal(p3.from, from);
      assert.deepEqual(changedFiles(third, 3), ['src/queued.ts']);
    } finally {
      await third.stop();
    }
  });
});

describe('snapshot refs', () => {
  const dirs = [];
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'dyffle-refs-'));
    dirs.push(dir);
    return dir;
  };
  const repo = () => {
    const dir = tmp();
    mkdirSync(join(dir, 'pkg/src'), { recursive: true });
    writeFileSync(join(dir, 'pkg/src/a.ts'), 'export const a = 1;\n');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    return dir;
  };
  const linked = (main) => {
    const wt = join(tmp(), 'wt');
    git(main, 'worktree', 'add', '-q', '--detach', wt, 'main');
    return wt;
  };
  const start = async (root) => {
    const session = new LiveSession({ root, baseRef: 'main' });
    await session.start();
    return session;
  };
  /** The same two post ids in each worktree, on sessions that started from different trees. */
  const twoWorktrees = async () => {
    const main = repo();
    const sides = [];
    for (const name of ['one', 'two']) {
      const root = linked(main);
      writeFileSync(join(root, `pkg/src/${name}-start.ts`), `export const start = '${name}';\n`);
      const session = await start(root);
      const posts = [];
      for (const id of [1, 2]) {
        const file = `pkg/src/${name}-${id}.ts`;
        writeFileSync(join(root, file), `export const v = '${name}-${id}';\n`);
        posts.push({ file, ...(await session.post({ message: `${name} ${id}`, change: true })) });
      }
      sides.push({ root, session, posts });
    }
    return { main, sides };
  };
  const stopAll = (sides) => Promise.all(sides.map((s) => s.session.stop()));
  const rev = (root, ref) => git(root, 'rev-parse', ref).trim();
  const refs = (root, prefix = 'refs/dyffle') => git(root, 'for-each-ref', '--format=%(refname)', prefix).split('\n').filter(Boolean).sort();
  const exists = (root, commit) => spawnSync('git', ['cat-file', '-e', commit], { cwd: root }).status === 0;
  after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it('keeps each linked worktree in refs of its own', async () => {
    const { main, sides } = await twoWorktrees();
    try {
      const snapshots = sides.flatMap((s) => s.posts.map((p) => p.snapshot));
      assert.equal(new Set(snapshots).size, 4);
      for (const { root, posts } of sides) {
        const ns = `refs/dyffle/worktrees/${worktreeId(root)}`;
        assert.equal(rev(root, `${ns}/start`), posts[0].from);
        for (const p of posts) assert.equal(rev(root, `${ns}/posts/${p.id}`), p.snapshot);
      }
      assert.notEqual(sides[0].posts[0].from, sides[1].posts[0].from);
      assert.notEqual(worktreeId(sides[0].root), worktreeId(sides[1].root));
      assert.equal(refs(main).length, 6);
      assert.ok(refs(main).every((r) => r.startsWith('refs/dyffle/worktrees/')));
      assert.deepEqual(refs(main, 'refs/worktree'), []);
    } finally {
      await stopAll(sides);
    }
  });

  it('keeps the snapshots of linked worktrees through git gc in any worktree', async () => {
    const { main, sides } = await twoWorktrees();
    try {
      for (const from of [main, sides[0].root, sides[1].root]) {
        git(from, 'gc', '--prune=now', '--quiet');
        for (const { root, session, posts } of sides) {
          assert.equal(refs(root).length, 6);
          for (const p of posts) {
            for (const commit of [p.from, p.snapshot]) assert.equal(git(root, 'cat-file', '-t', commit).trim(), 'commit');
            assert.equal(git(root, 'diff', '--name-only', p.from, p.snapshot).trim(), p.file);
            assert.ok(JSON.parse(session.index(p.id)).files.some((f) => f.path === p.file));
            assert.match(JSON.parse(session.source(`post-${p.id}`, p.file)).text, /export const v/);
          }
        }
        // Without a format too: that one needs the objects, and fails on a dangling ref.
        for (const root of [main, ...sides.map((s) => s.root)]) assert.equal(git(root, 'for-each-ref', 'refs/dyffle').trim().split('\n').length, 6);
      }
      for (const { root, session, posts } of sides) {
        const file = 'pkg/src/after-gc.ts';
        writeFileSync(join(root, file), `export const v = '${root}';\n`);
        const next = await session.post({ message: 'after gc', change: true });
        assert.equal(next.from, posts[1].snapshot);
        assert.equal(rev(root, `refs/dyffle/worktrees/${worktreeId(root)}/posts/${next.id}`), next.snapshot);
        assert.equal(git(root, 'diff', '--name-only', next.from, next.snapshot).trim(), file);
        assert.equal(JSON.parse(session.source(`post-${next.id}`, file)).text, `export const v = '${root}';\n`);
      }
    } finally {
      await stopAll(sides);
    }
  });

  it('starts clean on the id of a removed worktree, and keeps its refs when it resumes', async () => {
    const { main, sides } = await twoWorktrees();
    const [{ root, session, posts: old }, other] = sides;
    const id = worktreeId(root);
    const otherRefs = refs(main, `refs/dyffle/worktrees/${worktreeId(other.root)}`);
    assert.equal(otherRefs.length, 3);
    try {
      await session.stop();
      git(main, 'worktree', 'remove', '--force', root);
      git(main, 'worktree', 'add', '-q', '--detach', root, 'main');
      assert.equal(worktreeId(root), id);
      assert.equal(refs(main, `refs/dyffle/worktrees/${id}`).length, 3);

      writeFileSync(join(root, 'pkg/src/new-start.ts'), "export const start = 'new';\n");
      const fresh = await start(root);
      const ns = `refs/dyffle/worktrees/${id}`;
      assert.deepEqual(refs(main, ns), [`${ns}/start`]);
      assert.notEqual(rev(root, `${ns}/start`), old[0].from);
      assert.deepEqual(fresh.labels(), ['Branch (live)']);

      const file = 'pkg/src/new-1.ts';
      writeFileSync(join(root, file), "export const v = 'new';\n");
      const post = await fresh.post({ message: 'new', change: true });
      assert.equal(post.id, 1);
      assert.equal(post.from, rev(root, `${ns}/start`));
      assert.deepEqual(refs(main, ns), [`${ns}/posts/1`, `${ns}/start`]);
      assert.notEqual(post.snapshot, old[0].snapshot);
      assert.equal(git(root, 'diff', '--name-only', post.from, post.snapshot).trim(), file);
      await fresh.stop();

      // Stopped and started again, the session still has its state: the refs are its own.
      const before = refs(main, ns).map((r) => rev(main, r));
      const resumed = await start(root);
      assert.deepEqual(refs(main, ns).map((r) => rev(main, r)), before);
      await resumed.stop();
      assert.deepEqual(refs(main, `refs/dyffle/worktrees/${worktreeId(other.root)}`), otherRefs);
    } finally {
      await other.session.stop();
    }
  });

  it('removes the refs of a removed worktree and no others', async () => {
    const { main, sides } = await twoWorktrees();
    const [gone, kept] = sides;
    const session = await start(main);
    try {
      writeFileSync(join(main, 'main.ts'), 'export const m = 1;\n');
      const mainPost = await session.post({ message: 'main', change: true });
      const id = worktreeId(gone.root);
      const others = () => refs(main).filter((r) => !r.startsWith(`refs/dyffle/worktrees/${id}/`));
      const othersBefore = others().map((r) => [r, rev(main, r)]);
      assert.deepEqual(others().filter((r) => !r.startsWith('refs/dyffle/worktrees/')), ['refs/dyffle/posts/1', 'refs/dyffle/start']);
      // Git numbers ids that clash, so one id is a prefix of the other: wt and wt1.
      assert.deepEqual([id, worktreeId(kept.root)], ['wt', 'wt1']);
      assert.equal(refs(main).length, 8);

      assert.throws(() => removeWorktreeRefs(main, id), /still has this worktree/);
      assert.equal(refs(main).length, 8);

      await gone.session.stop();
      git(main, 'worktree', 'remove', '--force', gone.root);
      assert.equal(removeWorktreeRefs(kept.root, id), 3);
      assert.deepEqual(refs(main, `refs/dyffle/worktrees/${id}`), []);
      assert.deepEqual(others().map((r) => [r, rev(main, r)]), othersBefore);

      assert.equal(removeWorktreeRefs(main, id), 0);
      assert.equal(removeWorktreeRefs(main, 'no-such-worktree'), 0);
      assert.equal(removeWorktreeRefs(main, '*'), 0);
      assert.deepEqual(others().map((r) => [r, rev(main, r)]), othersBefore);

      git(main, 'gc', '--prune=now', '--quiet');
      assert.ok(!exists(main, gone.posts[0].snapshot));
      assert.ok(exists(main, kept.posts[0].snapshot));
      assert.ok(exists(main, mainPost.snapshot));
    } finally {
      await session.stop();
      await kept.session.stop();
    }
  });

  it('keeps writing refs/dyffle in the main worktree', async () => {
    const main = repo();
    assert.equal(worktreeId(main), undefined);
    // Reached through a symlink and from a subdirectory, where git gives one absolute and one relative path.
    const link = join(tmp(), 'link');
    symlinkSync(main, link, 'dir');
    for (const root of [main, join(link, 'pkg')]) {
      const session = await start(root);
      try {
        writeFileSync(join(root, 'b.ts'), `export const b = '${root}';\n`);
        const post = await session.post({ message: 'b', change: true });
        assert.equal(rev(main, `refs/dyffle/posts/${post.id}`), post.snapshot);
        assert.equal(rev(main, 'refs/dyffle/start'), post.from);
        assert.deepEqual(refs(main), ['refs/dyffle/posts/1', 'refs/dyffle/start']);
      } finally {
        await session.stop();
      }
      rmSync(join(root, '.dyffle'), { recursive: true });
    }
  });
});

describe('shared base index', () => {
  const dirs = [];
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'dyffle-cache-'));
    dirs.push(dir);
    return dir;
  };
  /** A repository of `from` on main, with `n` linked worktrees of the same commit. */
  const worktrees = (from, n) => {
    const repo = tmp();
    from(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    return Array.from({ length: n }, () => {
      const wt = join(tmp(), 'wt');
      git(repo, 'worktree', 'add', '-q', '--detach', wt, 'main');
      return wt;
    });
  };
  const nest = (dir) => cpSync(join(fixture, 'base'), dir, { recursive: true });
  const small = (dir) => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'src/b.ts'), "import { a } from './a';\nexport const b = a;\n");
  };
  /** Run a session from start to stop; returns its log and merged branch index. */
  const run = async (root, opts = {}) => {
    const log = [];
    const session = new LiveSession({ root, baseRef: 'main', log: (m) => log.push(m), ...opts });
    await session.start();
    const merged = JSON.parse(session.index(0));
    await session.stop();
    return { log, merged, indexed: log.some((m) => m.startsWith('Indexing')) };
  };
  const stored = (cache) => readdirSync(cache).sort();
  const onlyFile = (cache) => {
    const [name] = stored(cache);
    return join(cache, name);
  };
  const withoutTime = ({ generatedAt: _g, ...index }) => index;
  after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it('builds the base once for two worktrees, and the second merges as if it had built it', async () => {
    const [a, b] = worktrees(nest, 2);
    const cache = join(tmp(), 'not/yet/there');
    const first = await run(a, { baseCacheDir: cache });
    assert.ok(first.indexed);
    const commit = git(a, 'rev-parse', 'HEAD').trim();
    assert.deepEqual(stored(cache), [`base-${commit.slice(0, 12)}.json`]);
    assert.deepEqual(readdirSync(join(a, '.dyffle')).filter((f) => f.startsWith('base-')), []);

    // Nothing of the first worktree may be needed once its index is stored.
    const text = readFileSync(onlyFile(cache), 'utf8');
    const { root, ...paths } = JSON.parse(text);
    assert.equal(root, a);
    assert.ok(!JSON.stringify(paths).includes(a) && !text.includes('dyffle-base-'), 'an absolute path is left in the index');
    git(b, 'worktree', 'remove', '--force', a);

    cpSync(join(fixture, 'pr'), b, { recursive: true });
    writeFileSync(join(b, 'src/users/users.service.ts'), readFileSync(join(b, 'src/users/users.service.ts'), 'utf8').replace('findAllLegacy()', 'findAllLegacy(limit: number)'));
    const second = await run(b, { baseCacheDir: cache });
    assert.ok(!second.indexed, second.log.join('\n'));
    assert.deepEqual(readdirSync(join(b, '.dyffle')).filter((f) => f.startsWith('base-')), []);
    assert.equal(second.merged.root, b);
    assert.ok(second.merged.checks.summary.filesChanged > 0);

    // The same worktree and change with a base of its own: this is what the cache must reproduce.
    const own = await run(b);
    assert.ok(own.indexed);
    assert.deepEqual(readdirSync(join(b, '.dyffle')).filter((f) => f.startsWith('base-')), [`base-${commit.slice(0, 12)}.json`]);
    assert.deepEqual(withoutTime(second.merged), withoutTime(own.merged));
  });

  it('builds once when sessions in one process start at the same moment', async () => {
    const [a, b] = worktrees(small, 2);
    const baseCacheDir = tmp();
    const results = await Promise.all([run(a, { baseCacheDir }), run(b, { baseCacheDir })]);
    assert.deepEqual(results.map((r) => r.indexed), [true, false]);
    assert.equal(stored(baseCacheDir).length, 1);
  });

  it('survives two processes building the same commit at once', async () => {
    const [a, b] = worktrees(nest, 2);
    const baseCacheDir = tmp();
    const entry = new URL('../dist/index.js', import.meta.url).href;
    const script = `import { LiveSession } from ${JSON.stringify(entry)};
      const s = new LiveSession({ root: process.argv[1], baseRef: 'main', baseCacheDir: process.argv[2] });
      await s.start();
      await s.stop();`;
    const codes = await Promise.all(
      [a, b].map(
        (root) =>
          new Promise((done) => {
            spawn(process.execPath, ['--input-type=module', '-e', script, root, baseCacheDir], { stdio: 'inherit' }).once('exit', done);
          }),
      ),
    );
    assert.deepEqual(codes, [0, 0]);
    assert.equal(stored(baseCacheDir).length, 1, stored(baseCacheDir).join());
    assert.equal(JSON.parse(readFileSync(onlyFile(baseCacheDir), 'utf8')).kind, 'base');
    assert.ok(!(await run(a, { baseCacheDir })).indexed);
  });

  it('keeps indexes of different include, exclude and tsconfig options apart', async () => {
    const [a, b] = worktrees((dir) => {
      small(dir);
      writeFileSync(join(dir, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }\n');
      writeFileSync(join(dir, 'tsconfig.other.json'), '{ "compilerOptions": { "strict": false } }\n');
    }, 2);
    const baseCacheDir = tmp();
    const paths = (r) => r.merged.files.map((f) => f.path).sort();

    const plain = await run(a, { baseCacheDir });
    assert.ok(plain.indexed);
    assert.deepEqual(paths(plain), ['src/a.ts', 'src/b.ts']);

    const included = await run(b, { baseCacheDir, include: ['src/a.ts'] });
    assert.ok(included.indexed, 'include must not reuse the plain index');
    assert.deepEqual(paths(included), ['src/a.ts']);

    const excluded = await run(b, { baseCacheDir, exclude: ['src/a.ts'] });
    assert.ok(excluded.indexed, 'exclude must not reuse the plain index');
    assert.deepEqual(paths(excluded), ['src/b.ts']);

    assert.ok((await run(b, { baseCacheDir, tsconfig: join(b, 'tsconfig.other.json') })).indexed, 'tsconfig must not reuse the plain index');
    assert.equal(stored(baseCacheDir).length, 4);

    // The same options on another worktree do share, though the tsconfig's absolute path differs.
    assert.ok(!(await run(a, { baseCacheDir, include: ['src/a.ts'] })).indexed);
    assert.ok(!(await run(a, { baseCacheDir, tsconfig: join(a, 'tsconfig.other.json') })).indexed);
    assert.ok(!(await run(b, { baseCacheDir })).indexed);
    assert.equal(stored(baseCacheDir).length, 4);
  });

  it('keeps projects in different folders of one commit apart', async () => {
    const [a] = worktrees((dir) => {
      for (const pkg of ['one', 'two']) {
        mkdirSync(join(dir, pkg, 'src'), { recursive: true });
        writeFileSync(join(dir, pkg, `src/${pkg}.ts`), `export const ${pkg} = 1;\n`);
      }
    }, 1);
    const baseCacheDir = tmp();
    const one = await run(join(a, 'one'), { baseCacheDir });
    const two = await run(join(a, 'two'), { baseCacheDir });
    assert.ok(one.indexed && two.indexed);
    assert.deepEqual(one.merged.files.map((f) => f.path), ['src/one.ts']);
    assert.deepEqual(two.merged.files.map((f) => f.path), ['src/two.ts']);
  });

  it('rebuilds and replaces a file it cannot use', async () => {
    const [a] = worktrees(small, 1);
    const baseCacheDir = tmp();
    await run(a, { baseCacheDir });
    const file = onlyFile(baseCacheDir);
    const good = JSON.parse(readFileSync(file, 'utf8'));
    const bad = {
      truncated: JSON.stringify(good).slice(0, 50),
      empty: '',
      null: 'null',
      'no nodes': JSON.stringify({ ...good, nodes: undefined }),
      'another commit': JSON.stringify({ ...good, commit: '0'.repeat(40) }),
      'another schema': JSON.stringify({ ...good, schemaVersion: good.schemaVersion + 1 }),
      'another dyffle': JSON.stringify({ ...good, tool: { ...good.tool, version: '0.0.0-old' } }),
    };
    for (const [what, text] of Object.entries(bad)) {
      writeFileSync(file, text);
      const r = await run(a, { baseCacheDir });
      assert.ok(r.indexed, what);
      assert.deepEqual(r.merged.files.map((f) => f.path).sort(), ['src/a.ts', 'src/b.ts'], what);
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).commit, good.commit, what);
      assert.ok(!(await run(a, { baseCacheDir })).indexed, what);
    }
    assert.equal(stored(baseCacheDir).length, 1);
  });

  it('carries on, with a warning, when the file cannot be stored', async () => {
    const [a] = worktrees(small, 1);
    const cache = tmp();
    const notDir = join(cache, 'file');
    writeFileSync(notDir, '');
    const r = await run(a, { baseCacheDir: notDir });
    assert.ok(r.indexed);
    assert.ok(r.log.some((m) => m.startsWith('warning: could not store the base index')), r.log.join('\n'));
    assert.equal(r.merged.files.length, 2);

    // A folder where the file belongs: nothing to read, the rename fails, and no temp file stays.
    const commit = git(a, 'rev-parse', 'HEAD').trim();
    mkdirSync(join(cache, 'c', `base-${commit.slice(0, 12)}.json`), { recursive: true });
    const blocked = await run(a, { baseCacheDir: join(cache, 'c') });
    assert.ok(blocked.indexed);
    assert.ok(blocked.log.some((m) => m.startsWith('warning: could not store the base index')), blocked.log.join('\n'));
    assert.equal(stored(join(cache, 'c')).length, 1);
  });
});

describe('LiveSession.post', () => {
  const roots = [];
  /** A temp repo on a feature branch. */
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'dyffle-'));
    roots.push(dir);
    cpSync(join(fixture, 'base'), dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    git(dir, 'checkout', '-qb', 'feature');
    return dir;
  };
  const started = async (dir, opts = {}) => {
    const session = new LiveSession({ root: dir, baseRef: 'main', interval: 20, ...opts });
    await session.start();
    return session;
  };
  const posts = (session) => JSON.parse(session.feed()).posts;
  const add = (dir, name) => writeFileSync(join(dir, `src/${name}.ts`), `export const ${name} = 1;\n`);
  const changedFiles = (session, i) => JSON.parse(session.index(i)).pr.changedFiles;
  const waitFor = async (what, ok) => {
    const deadline = Date.now() + 30000;
    while (!ok()) {
      assert.ok(Date.now() < deadline, `${what} did not happen`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it('makes the same post as the inbox', async () => {
    // Two repos with the same history, so even the ids and file names can match.
    const made = [];
    for (const via of ['inbox', 'post']) {
      const dir = repo();
      const session = await started(dir);
      const events = [];
      session.subscribe((event, data) => event === 'feed' && events.push(data));
      try {
        add(dir, 'one');
        const input = { title: 'One', message: 'A *change*', author: 'me', change: true };
        let returned;
        if (via === 'post') returned = await session.post(input);
        else {
          writeFileSync(join(dir, '.dyffle/inbox/a.json'), JSON.stringify(input));
          await waitFor('the inbox post', () => posts(session).length === 1);
        }
        const stored = JSON.parse(readFileSync(join(dir, '.dyffle/posts/0001.json'), 'utf8'));
        if (returned) assert.deepEqual(returned, stored);
        assert.deepEqual(readdirSync(join(dir, '.dyffle/inbox')), []);
        assert.equal(git(dir, 'rev-parse', 'refs/dyffle/posts/1').trim(), stored.snapshot);
        assert.equal(JSON.parse(readFileSync(join(dir, '.dyffle/state.json'), 'utf8')).snapshot, stored.snapshot);
        assert.equal(stored.from, git(dir, 'rev-parse', 'refs/dyffle/start').trim());
        assert.deepEqual(changedFiles(session, 1), ['src/one.ts']);
        assert.deepEqual(session.labels(), ['Branch (live)', '#1 One']);
        assert.ok(changedFiles(session, 0).includes('src/one.ts'));
        const text = (f) => readFileSync(join(dir, '.dyffle/posts', f), 'utf8');
        made.push({
          files: readdirSync(join(dir, '.dyffle/posts')).sort(),
          // What differs per run, and the source, which only a post from the inbox has.
          post: { ...stored, createdAt: '', snapshot: '', from: '', source: '' },
          dyffle: text('0001.dyffle.json')
            .replaceAll(dir, '<root>')
            .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
            .replace(/"generatedAt":"[^"]*"/g, ''),
          events,
          source: stored.source,
        });
      } finally {
        await session.stop();
      }
    }
    const [inbox, direct] = made;
    assert.equal(inbox.source, 'a.json');
    assert.equal(direct.source, undefined);
    assert.deepEqual(direct.files, ['0001.dyffle.json', '0001.json']);
    assert.deepEqual(direct.events, [{ id: 1 }]);
    for (const made of [inbox, direct]) delete made.source;
    assert.deepEqual(direct, inbox);
  });

  it('makes a message without a change, under the default author', async () => {
    const session = await started(repo());
    try {
      const p = await session.post({ message: 'Just a question' });
      assert.deepEqual(Object.keys(p).sort(), ['author', 'createdAt', 'id', 'message']);
      assert.equal(p.author, 'claude');
      // The caller's copy is not the feed's.
      p.message = 'changed';
      assert.equal(posts(session)[0].message, 'Just a question');
    } finally {
      await session.stop();
    }
  });

  it('gives concurrent posts sequential ids, each change measuring from the previous one', async () => {
    const dir = repo();
    const session = await started(dir);
    try {
      const start = git(dir, 'rev-parse', 'refs/dyffle/start').trim();
      // A new file after every post, so that each next one has a change of its own only if they run in order.
      const order = ['c1', 'c2', 'inboxed', 'c3', 'c4'];
      const unsubscribe = session.subscribe((event, { id }) => event === 'feed' && add(dir, `after${id}`));
      add(dir, 'first');
      writeFileSync(join(dir, '.dyffle/inbox/a.json'), JSON.stringify({ message: 'inboxed', change: true }));
      const returned = await Promise.all(order.filter((m) => m !== 'inboxed').map((message) => session.post({ message, change: true })));
      await waitFor('the inbox post', () => posts(session).length === order.length);
      unsubscribe();

      const all = posts(session);
      assert.deepEqual(all.map((p) => p.id), [1, 2, 3, 4, 5]);
      assert.deepEqual(returned.map((p) => p.id), all.filter((p) => !p.source).map((p) => p.id));
      assert.equal(new Set(all.map((p) => p.snapshot)).size, all.length);
      all.forEach((p, i) => {
        assert.equal(p.from, i ? all[i - 1].snapshot : start, `#${p.id} measures from the previous post`);
        assert.equal(git(dir, 'rev-parse', `refs/dyffle/posts/${p.id}`).trim(), p.snapshot);
        // The first has the file from before; each next one just the file written after the previous post.
        assert.deepEqual(changedFiles(session, i + 1), i ? [`src/after${i}.ts`] : ['src/first.ts']);
      });
      assert.deepEqual(readdirSync(join(dir, '.dyffle/posts')).filter((f) => /^\d+\.json$/.test(f)), ['0001.json', '0002.json', '0003.json', '0004.json', '0005.json']);
    } finally {
      await session.stop();
    }
  });

  it('does not let overlapping ticks take an inbox file twice', async () => {
    const dir = repo();
    const session = await started(dir);
    try {
      writeFileSync(join(dir, '.dyffle/inbox/a.json'), JSON.stringify({ message: 'Once' }));
      await Promise.all([session.tick(), session.tick(), session.post({ message: 'Other' })]);
      assert.deepEqual(posts(session).map((p) => p.message).sort(), ['Once', 'Other']);
    } finally {
      await session.stop();
    }
  });

  it('does not let a rebuild put back a tree older than a post', async () => {
    const dir = repo();
    const session = await started(dir);
    try {
      add(dir, 'early');
      const posted = session.post({ message: 'Now', change: true });
      // Looks at the working tree when its turn comes: it must not hold on to a tree from before the post.
      const ticked = session.tick();
      add(dir, 'late');
      await Promise.all([posted, ticked]);
      assert.deepEqual(changedFiles(session, 0).sort(), ['src/early.ts', 'src/late.ts']);
    } finally {
      await session.stop();
    }
  });

  it('rejects invalid input with the error of the inbox, without an .error file', async () => {
    const dir = repo();
    const session = await started(dir);
    try {
      const bad = [{ message: '' }, { message: '  ' }, {}, { message: 1 }, { message: 'x', title: 1 }, { message: 'x', author: 1 }, { message: 'x', change: 'yes' }, null, 'text'];
      for (const input of bad) {
        const error = await session.post(input).then(
          () => assert.fail(`${JSON.stringify(input)} was accepted`),
          (e) => e,
        );
        writeFileSync(join(dir, '.dyffle/inbox/bad.json'), JSON.stringify(input));
        await waitFor('the inbox rejection', () => existsSync(join(dir, '.dyffle/inbox/bad.error')));
        assert.equal(`${error.message}\n`, readFileSync(join(dir, '.dyffle/inbox/bad.error'), 'utf8'));
        unlinkSync(join(dir, '.dyffle/inbox/bad.error'));
        await assert.rejects(session.post(input));
        assert.deepEqual(readdirSync(join(dir, '.dyffle/inbox')), []);
      }
      assert.deepEqual(posts(session), []);
      assert.equal((await session.post({ message: 'Good' })).id, 1);
    } finally {
      await session.stop();
    }
  });

  it('rejects when the post cannot be made, and the next one takes its id', async () => {
    const dir = repo();
    const session = await started(dir);
    try {
      add(dir, 'one');
      renameSync(join(dir, '.git'), join(dir, '.git-away'));
      const failed = session.post({ message: 'Fails', change: true });
      const next = failed.catch(() => {}).then(() => renameSync(join(dir, '.git-away'), join(dir, '.git'))).then(() => session.post({ message: 'Works', change: true }));
      await assert.rejects(failed);
      const p = await next;
      assert.equal(p.id, 1);
      assert.deepEqual(changedFiles(session, 1), ['src/one.ts']);
    } finally {
      await session.stop();
    }
  });

  it('rejects on a session that is not started, and writes nothing', async () => {
    const dir = repo();
    const session = new LiveSession({ root: dir, baseRef: 'main' });
    await assert.rejects(session.post({ message: 'Early' }), /not started/);
    assert.ok(!existsSync(join(dir, '.dyffle')));
    // Nor after a start that failed.
    const failed = new LiveSession({ root: dir, baseRef: 'no-such-ref' });
    await assert.rejects(failed.start());
    await assert.rejects(failed.post({ message: 'Early' }), /not started/);
    assert.deepEqual(readdirSync(join(dir, '.dyffle/posts')), []);
  });

  it('finishes posts accepted before stop(), and rejects those after it', async () => {
    const dir = repo();
    const session = await started(dir);
    add(dir, 'one');
    const accepted = session.post({ message: 'In time', change: true });
    await session.stop();
    assert.ok(existsSync(join(dir, '.dyffle/posts/0001.json')));
    assert.equal((await accepted).id, 1);

    await assert.rejects(session.post({ message: 'Late' }), /stopped/);
    assert.deepEqual(posts(session).map((p) => p.id), [1]);
    assert.ok(!existsSync(join(dir, '.dyffle/posts/0002.json')));
    // A stopped session stays stopped, even through start(); a new one carries on.
    await session.start();
    await assert.rejects(session.post({ message: 'Late' }), /stopped/);
    await session.stop();
    const again = await started(dir);
    try {
      add(dir, 'two');
      const p = await again.post({ message: 'Resumed', change: true });
      assert.equal(p.id, 2);
      assert.deepEqual(changedFiles(again, 2), ['src/two.ts']);
    } finally {
      await again.stop();
    }
  });
});

describe('unannounce', () => {
  let roots = [];
  const root = () => {
    const dir = mkdtempSync(join(tmpdir(), 'dyffle-'));
    roots.push(dir);
    mkdirSync(join(dir, '.dyffle'));
    return dir;
  };
  const serverJson = (dir) => join(dir, '.dyffle/server.json');
  // announce() and unannounce() need no started session or git repo.
  const session = (dir) => new LiveSession({ root: dir, baseRef: 'main' });
  after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it('removes the file announce() wrote, and only in its own root', () => {
    const [a, b] = [root(), root()];
    const [sa, sb] = [session(a), session(b)];
    sa.announce('http://127.0.0.1:1/');
    sb.announce('http://127.0.0.1:2/');
    sa.unannounce();
    assert.ok(!existsSync(serverJson(a)));
    assert.equal(JSON.parse(readFileSync(serverJson(b), 'utf8')).url, 'http://127.0.0.1:2/');
  });

  it('leaves the file of another process alone', () => {
    const dir = root();
    const other = JSON.stringify({ pid: process.pid + 1, url: 'http://127.0.0.1:1/' });
    writeFileSync(serverJson(dir), other);
    session(dir).unannounce();
    assert.equal(readFileSync(serverJson(dir), 'utf8'), other);
  });

  it('is no error on a missing or malformed file', () => {
    const dir = root();
    session(dir).unannounce();
    session(join(dir, 'no-such-root')).unannounce();
    for (const text of ['', '{"pid":', 'null', '12', '[]', `{"pid":"${process.pid}"}`]) {
      writeFileSync(serverJson(dir), text);
      session(dir).unannounce();
      assert.equal(readFileSync(serverJson(dir), 'utf8'), text);
    }
  });

  describe('dyffle watch quitting', () => {
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    /** Run watch on a temp repo until server.json is there, run during(), SIGTERM it, return its exit code. */
    const watchUntilQuit = async (dir, during = () => {}) => {
      const child = spawn(process.execPath, [cli, 'watch', '--base-ref', 'main', '--root', dir, '--port', '0'], { stdio: 'ignore' });
      const exit = new Promise((r) => child.once('exit', (code) => r(code)));
      try {
        const deadline = Date.now() + 30000;
        while (!existsSync(serverJson(dir))) {
          assert.ok(Date.now() < deadline, 'watch did not announce itself');
          await new Promise((r) => setTimeout(r, 20));
        }
        during();
      } finally {
        child.kill('SIGTERM');
      }
      return exit;
    };
    const repo = () => {
      const dir = mkdtempSync(join(tmpdir(), 'dyffle-'));
      roots.push(dir);
      cpSync(join(fixture, 'base'), dir, { recursive: true });
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'base');
      return dir;
    };

    it('removes its own server.json', async () => {
      const dir = repo();
      assert.equal(await watchUntilQuit(dir), 0);
      assert.ok(!existsSync(serverJson(dir)));
    });

    it('keeps a server.json another process took over', async () => {
      const dir = repo();
      const other = JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:1/' });
      assert.equal(await watchUntilQuit(dir, () => writeFileSync(serverJson(dir), other)), 0);
      assert.equal(readFileSync(serverJson(dir), 'utf8'), other);
    });
  });
});
