import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildBaseIndex, buildOverlay, embedSection, markdownReport, merge, mermaidModuleMap, parseUnifiedDiff, reverseApply, sliceHunks, standaloneHtml } from '../dist/index.js';

const fixture = fileURLToPath(new URL('./fixtures/nest-app/', import.meta.url));
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=dyff', '-c', 'user.email=dyff@example.com', ...args], { cwd, encoding: 'utf8' });

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
    dir = mkdtempSync(join(tmpdir(), 'dyff-'));
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

  it('finds references the PR broke', () => {
    // A .json import is a use of a file dyff never indexes; it is not broken.
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
    assert.equal(first, 'My description\n\n---\n\n<!-- dyff:start -->\nreport v1\n<!-- dyff:end -->\n');
    const edited = first + '\nA note added later';
    assert.equal(embedSection(edited, 'report v2'), edited.replace('report v1', 'report v2'));
    assert.equal(embedSection('', 'r'), '<!-- dyff:start -->\nr\n<!-- dyff:end -->\n');
    // Markers mentioned inline are not section boundaries.
    const mention = 'Sits between `<!-- dyff:start -->` / `<!-- dyff:end -->`.';
    assert.equal(embedSection(mention, 'r'), mention + '\n\n---\n\n<!-- dyff:start -->\nr\n<!-- dyff:end -->\n');
    // Descriptions edited on github.com use CRLF line endings.
    const crlf = 'Intro\r\n\r\n<!-- dyff:start -->\r\nold\r\n<!-- dyff:end -->\r\nOutro';
    assert.equal(embedSection(crlf, 'new'), 'Intro\r\n\r\n<!-- dyff:start -->\nnew\n<!-- dyff:end -->\r\nOutro');
  });

  it('exports the viewer as one self-contained HTML file', () => {
    const html = standaloneHtml(merged);
    assert.match(html, /<script>window\.DYFF_DATA = \{/);
    assert.ok(!html.slice(html.indexOf('DYFF_DATA'), html.indexOf('</script>', html.indexOf('DYFF_DATA'))).includes('<'));
  });

  it('writes a markdown report', () => {
    const md = markdownReport(merged);
    assert.match(md, /This PR breaks 2 references/);
    assert.match(md, /GET \/api\/reports\/users\/:id/);
    assert.match(md, /`src\/auth` ⇄ `src\/users`/);
  });
});

describe('cycles that exist before the PR', () => {
  let dir;
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('does not report an existing cycle as new when the PR removes one of its modules', () => {
    dir = mkdtempSync(join(tmpdir(), 'dyff-'));
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
