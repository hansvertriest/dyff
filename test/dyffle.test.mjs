import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildBaseIndex, buildOverlay, embedSection, LiveSession, markdownReport, merge, mermaidModuleMap, parseUnifiedDiff, query, reach, reachGraph, readReviewInput, rebase, reverseApply, reviewsMarkdown, serve, sliceHunks, standaloneHtml } from '../dist/index.js';

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
  const views = () => JSON.parse(session.views()).views;
  const at = (key) => JSON.parse(session.index(views().find((v) => v.key === key).index));
  const head = () => git(dir, 'rev-parse', 'HEAD').trim();
  let first, second;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dyffle-'));
    cpSync(join(fixture, 'base'), dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'base');
    git(dir, 'checkout', '-qb', 'feature');
    appendFileSync(join(dir, 'src/main.ts'), '\nexport const early = 1;\n');
    git(dir, 'commit', '-qam', 'Early change');
    first = head();
    // Untracked: part of the branch and of the uncommitted changes.
    writeFileSync(join(dir, 'src/extra.ts'), 'export const extra = 2;\n');
    session = new LiveSession({ root: dir, baseRef: 'main', interval: 50 });
    await session.start();
    await session.stop();
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps a dyffle of the whole branch, of each commit and of the uncommitted changes', async () => {
    await session.tick();
    assert.deepEqual(session.labels(), ['Branch (live)', `${first.slice(0, 7)} Early change`, 'Uncommitted']);
    assert.deepEqual(views().map((v) => [v.key, v.kind, v.index]), [['live', 'branch', 0], [`commit-${first}`, 'commit', 1], ['uncommitted', 'uncommitted', 2]]);
    assert.deepEqual(at('live').pr.changedFiles.sort(), ['src/extra.ts', 'src/main.ts']);
    const commit = at(`commit-${first}`);
    assert.deepEqual(commit.pr.changedFiles, ['src/main.ts']);
    assert.equal(commit.pr.title, 'Early change');
    assert.equal(commit.pr.headCommit, first);
    assert.equal(commit.root, dir);
    assert.ok(commit.nodes.some((n) => n.id === 'src/main.ts#early' && n.change?.status === 'added'));
    const uncommitted = at('uncommitted');
    assert.deepEqual(uncommitted.pr.changedFiles, ['src/extra.ts']);
    assert.equal(uncommitted.pr.baseCommit, first);
    assert.equal(views()[1].author, 'dyffle');
    assert.deepEqual(views()[1].stats, { files: 1, additions: 2, deletions: 0, symbols: 1 });
    assert.ok(existsSync(join(dir, `.dyffle/commits/${first}.json`)));
    assert.ok(!git(dir, 'status', '--porcelain').includes('.dyffle'));
    assert.equal(git(dir, 'diff', '--cached', '--name-only'), '');
  });

  it('rebuilds the branch and uncommitted dyffles when a file changes', async () => {
    const before = session.index(0);
    await session.tick();
    assert.equal(session.index(0), before);
    const file = join(dir, 'src/orders/orders.service.ts'), text = readFileSync(file, 'utf8');
    appendFileSync(file, '\nexport function helper() {}\n');
    await session.tick();
    for (const key of ['live', 'uncommitted'])
      assert.ok(at(key).nodes.some((n) => n.id === 'src/orders/orders.service.ts#helper' && n.change?.status === 'added'), key);
    writeFileSync(file, text);
    await session.tick();
    assert.ok(!at('uncommitted').pr.changedFiles.includes('src/orders/orders.service.ts'));
  });

  it('adds a dyffle for a new commit, built from the commit and not the working tree', async () => {
    cpSync(join(fixture, 'pr/src/auth'), join(dir, 'src/auth'), { recursive: true });
    git(dir, 'add', 'src/auth');
    git(dir, 'commit', '-qm', 'Add auth');
    second = head();
    // Saved after the commit: uncommitted, so not in the commit's dyffle.
    cpSync(join(fixture, 'pr/src/users/users.service.ts'), join(dir, 'src/users/users.service.ts'));
    await session.tick();
    assert.deepEqual(session.labels().slice(1), [`${first.slice(0, 7)} Early change`, `${second.slice(0, 7)} Add auth`, 'Uncommitted']);
    const commit = at(`commit-${second}`);
    assert.ok(commit.pr.changedFiles.every((f) => f.startsWith('src/auth/')), commit.pr.changedFiles.join());
    assert.equal(commit.pr.baseCommit, first);
    assert.ok(commit.nodes.some((n) => n.id === 'src/auth/auth.service.ts#AuthService' && n.change?.status === 'added'));
    assert.deepEqual(at('uncommitted').pr.changedFiles.sort(), ['src/extra.ts', 'src/users/users.service.ts']);
    assert.ok(at('live').pr.changedFiles.includes('src/auth/auth.service.ts'));
  });

  it('drops the dyffle of a commit that left the branch', async () => {
    git(dir, 'commit', '-q', '--amend', '-m', 'Add auth module');
    const amended = head();
    await session.tick();
    assert.deepEqual(views().map((v) => v.key), ['live', `commit-${first}`, `commit-${amended}`, 'uncommitted']);
    assert.equal(views()[2].title, 'Add auth module');
    assert.ok(!existsSync(join(dir, `.dyffle/commits/${second}.json`)));
    second = amended;
  });

  it('serves the views and streams changes', async () => {
    const { server, url } = await serve(session, { port: 0 });
    try {
      assert.deepEqual((await (await fetch(url + 'views.json')).json()).views.map((v) => v.key), views().map((v) => v.key));
      assert.deepEqual(await (await fetch(url + 'indexes.json')).json(), session.labels());
      assert.equal((await fetch(url + 'feed.json')).status, 404);
      const res = await fetch(url + 'events');
      const reader = res.body.getReader();
      await reader.read();
      writeFileSync(join(dir, 'src/late.ts'), 'export const late = 3;\n');
      await session.tick();
      let text = '';
      while (!text.includes('event: views')) text += new TextDecoder().decode((await reader.read()).value);
      assert.match(text, /event: views\ndata: \{"changed":\["live","uncommitted"\]\}/);
      await reader.cancel();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('keeps reviews of the branch, the commits and the uncommitted changes, and lists them as Markdown', async () => {
    const { server, url } = await serve(session, { port: 0 });
    const key = `commit-${second}`;
    try {
      assert.deepEqual(await (await fetch(url + `review.json?key=${key}`)).json(), { key, body: '', comments: [], viewed: {} });
      assert.equal((await fetch(url + 'review.json?key=../x')).status, 404);
      assert.equal((await fetch(url + 'review.json?key=post-2')).status, 404);
      const events = await fetch(url + 'events');
      const reader = events.body.getReader();
      await reader.read();
      const comment = { id: 'a', path: 'src/auth/auth.service.ts', line: 1, side: 'RIGHT', body: 'Why?', code: 'import x;', symbol: 'src/auth/auth.service.ts#AuthService', created: 1 };
      const put = await fetch(url + `review.json?key=${key}&client=me`, { method: 'PUT', body: JSON.stringify({ body: 'Looks good', comments: [comment], viewed: { 'src/auth/auth.service.ts': 'h1' } }) });
      assert.equal(put.status, 204);
      let text = '';
      while (!text.includes('event: review')) text += new TextDecoder().decode((await reader.read()).value);
      assert.ok(text.includes(`"key":"${key}","client":"me","comments":1`));
      await reader.cancel();
      const stored = JSON.parse(readFileSync(join(dir, `.dyffle/reviews/${key}.json`), 'utf8'));
      assert.equal(stored.title, 'Add auth module');
      assert.equal(stored.headCommit, second);
      assert.deepEqual(stored.viewed, { 'src/auth/auth.service.ts': 'h1' });
      assert.equal(views().find((v) => v.key === key).comments, 1);
      // A commit that is not on the branch has no review, and bad input is refused.
      assert.equal((await fetch(url + `review.json?key=commit-${'0'.repeat(40)}`, { method: 'PUT', body: JSON.stringify({ body: '', comments: [] }) })).status, 400);
      assert.equal((await fetch(url + 'review.json?key=live', { method: 'PUT', body: '{"body":1}' })).status, 400);
      assert.throws(() => readReviewInput({ body: '', comments: [{ id: 'x', path: 'a', line: 1, side: 'UP', body: '' }] }), /side/);

      const main = readFileSync(join(dir, 'src/main.ts'), 'utf8').split('\n');
      session.saveReview('live', JSON.stringify({ body: '', comments: [
        { id: 'b', path: 'src/main.ts', line: 1, side: 'RIGHT', body: 'Still here', code: main[0], created: 2 },
        { id: 'c', path: 'src/main.ts', line: 2, side: 'RIGHT', body: 'Was here', code: 'something else', created: 3 },
      ], viewed: {} }));
      session.saveReview('uncommitted', JSON.stringify({ body: 'Commit this', comments: [], viewed: {} }));
      assert.equal(JSON.parse(readFileSync(join(dir, '.dyffle/reviews/uncommitted.json'), 'utf8')).title, 'Uncommitted changes');
      const md = reviewsMarkdown(dir);
      assert.ok(md.includes(`## Commit ${second.slice(0, 7)}: Add auth module\n\nLooks good\n\n- **src/auth/auth.service.ts:1 in \`AuthService\`**\n`), md);
      assert.match(md, /src\/main\.ts:1\*\*\n/);
      assert.match(md, /src\/main\.ts:2\*\* \(outdated: the line changed since\)/);
      // The order of the picker: the whole branch, the commits, then the uncommitted changes.
      assert.deepEqual(md.match(/^## .*/gm).map((h) => h.split(':')[0]), ['## Whole branch (live)', `## Commit ${second.slice(0, 7)}`, '## Uncommitted changes']);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('serves files as the dyffle they are in shows them', async () => {
    const key = `commit-${second}`;
    const atCommit = git(dir, 'show', `${second}:src/auth/auth.service.ts`);
    appendFileSync(join(dir, 'src/auth/auth.service.ts'), '\n// after the commit\n');
    await session.tick();
    assert.equal(JSON.parse(session.source(key, 'src/auth/auth.service.ts')).text, atCommit);
    assert.ok(JSON.parse(session.source('uncommitted', 'src/auth/auth.service.ts')).text.includes('after the commit'));
    // The live dyffles serve their own tree: an edit since the last rebuild doesn't show yet.
    const file = join(dir, 'src/users/users.service.ts'), text = readFileSync(file, 'utf8');
    appendFileSync(file, '\n// not yet\n');
    assert.equal(JSON.parse(session.source('live', 'src/users/users.service.ts')).text, text);
    writeFileSync(file, text);
    // Unchanged files too, but nothing outside the dyffle, and no unknown commits.
    assert.ok(JSON.parse(session.source('live', 'src/main.ts')).text.includes('bootstrap'));
    for (const [k, path] of [['live', '../outside.ts'], ['live', '.dyffle/views.json'], ['live', 'tsconfig.json'], [`commit-${'0'.repeat(40)}`, 'src/main.ts'], ['x', 'src/main.ts']])
      assert.equal(session.source(k, path), undefined, `${k} ${path}`);
    const { server, url } = await serve(session, { port: 0 });
    try {
      assert.equal((await (await fetch(url + `source.json?key=${key}&path=src/auth/auth.service.ts`)).json()).text, atCommit);
      assert.equal((await fetch(url + 'source.json?key=live&path=../x')).status, 404);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('picks up the commits from its cache after a restart', async () => {
    const logs = [];
    const again = new LiveSession({ root: dir, baseRef: 'main', log: (m) => logs.push(m) });
    await again.start();
    await again.stop();
    assert.deepEqual(again.labels(), session.labels());
    assert.equal(again.index(2), session.index(2));
    assert.ok(!logs.some((m) => m.startsWith('Commit ') || m.startsWith('Indexing')), logs.join('\n'));
  });

  it('no longer takes posts', () => {
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    assert.throws(() => execFileSync(process.execPath, [cli, 'post', '-m', 'hi'], { cwd: dir, stdio: 'pipe' }), (e) => /"dyffle post" was removed/.test(e.stderr.toString()));
  });
});
