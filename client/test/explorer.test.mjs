import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const app = require('../../server/src');
const express = createRequire(require.resolve('../../server/package.json'))('express');
const fixture = fileURLToPath(new URL('../../core/test/fixtures/function-project/', import.meta.url));
const cycles = fileURLToPath(new URL('../../core/test/fixtures/analysis-project/', import.meta.url));
const mixed = fileURLToPath(new URL('../../core/test/fixtures/multilang/', import.meta.url));
const medium = JSON.parse(readFileSync(new URL('../src/sample-graph-200.json', import.meta.url), 'utf8'));
const defaultRepo = 'https://github.com/jonschlinkert/is-number';
let server, browser, url;

before(async () => {
  app.use(express.static(fileURLToPath(new URL('../dist/', import.meta.url))));
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch(process.env.COCKPIT_BROWSER_CHANNEL
    ? { channel: process.env.COCKPIT_BROWSER_CHANNEL } : {});
});

after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function open(t, { viewport = { width: 1450, height: 940 }, workerFailure = false } = {}) {
  const page = await browser.newPage({ viewport });
  t.after(() => page.close());
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if ((message.type() === 'error' || message.type() === 'warning') &&
      !/network error|ERR_|Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  await page.addInitScript(({ workerFailure }) => {
    window.explorerWorkers = { started: 0, active: 0 };
    const BaseWorker = window.Worker;
    window.Worker = class extends BaseWorker {
      constructor(...args) {
        if (workerFailure) throw new Error('Worker rejected by test');
        super(...args);
        window.explorerWorkers.started++;
        window.explorerWorkers.active++;
      }
      terminate() {
        window.explorerWorkers.active--;
        super.terminate();
      }
    };
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: undefined });
  }, { workerFailure });
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ body: '', contentType: 'text/css' }));
  await page.goto(url);
  return { page, errors };
}

async function arranged(page) {
  await page.locator('.graph-surface canvas').first().waitFor({ state: 'visible' });
  await page.waitForFunction(() => window.explorerWorkers.started > 0 && window.explorerWorkers.active === 0);
  await page.locator('.layout-status').waitFor({ state: 'hidden' });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function canvasState(page) {
  return page.locator('.graph-surface').evaluate(element => {
    const cy = element._cyreg.cy;
    return {
      nodes: cy.nodes().map(node => ({ id: node.data('canonicalId'), label: node.data('label'), classes: node.classes(),
        bounds: node.boundingBox({ includeLabels: false }) })),
      edges: cy.edges().map(edge => ({ id: edge.data('canonicalId'), classes: edge.classes(), loop: edge.isLoop(),
        drawable: Number.isFinite(edge.renderedMidpoint()?.x) && Number.isFinite(edge.renderedMidpoint()?.y),
        source: edge.source().data('canonicalId'), target: edge.target().data('canonicalId') })),
    };
  });
}

async function tapEdge(page, id) {
  await arranged(page);
  const point = await page.locator('.graph-surface').evaluate((element, edgeId) => {
    const point = element._cyreg.cy.getElementById('edge:' + edgeId).renderedMidpoint();
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x + point.x, y: bounds.y + point.y };
  }, id);
  await page.mouse.click(point.x, point.y);
}

async function chooseFolder(page, folder) {
  await page.getByRole('button', { name: 'Local folder' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Select folder', exact: true }).click();
  const response = page.waitForResponse(res => new URL(res.url()).pathname === '/api/analyze-upload');
  await (await chooser).setFiles(folder);
  const result = await response;
  assert.equal(result.status(), 200, await result.text());
  return result.json();
}

async function search(page, query, name) {
  await page.getByRole('searchbox').fill(query);
  const matches = page.getByLabel('Search results');
  await matches.getByRole('button', { name: name ?? new RegExp(query.replaceAll('.', '\\.')), exact: false }).first().click();
}

async function analyze(page, repo = defaultRepo) {
  if (!await page.getByLabel('Repository URL').isVisible()) await page.getByRole('button', { name: 'GitHub', exact: true }).click();
  const response = page.waitForResponse(res => new URL(res.url()).pathname === '/api/analyze');
  await page.getByLabel('Repository URL').fill(repo);
  await page.getByRole('button', { name: 'Analyze repository' }).click();
  return response;
}

test('compiler-backed upload, call evidence, focus, expansion and file navigation', async t => {
  const { page, errors } = await open(t);
  const data = await chooseFolder(page, fixture);
  assert.ok(data.functionGraph.edges.some(edge => edge.caller === edge.callee));
  assert.ok(data.functionGraph.nodes.filter(node => node.name === 'same').length >= 2);
  await arranged(page);
  await search(page, 'app/consumer.ts');
  const file = page.getByRole('complementary', { name: 'File inspector' });
  await file.getByText('Direct dependencies', { exact: true }).waitFor();
  await file.getByRole('button', { name: 'Inspect dependency to lib/index.ts' }).click();
  const dependency = page.getByRole('complementary', { name: 'Dependency inspector' });
  await dependency.getByText('forwarded', { exact: false }).first().waitFor();
  await dependency.getByRole('button', { name: /consumer\.ts/ }).click();
  await file.getByRole('button', { name: 'Inspect dependency to lib/service.ts' }).click();
  await dependency.getByRole('button', { name: /entry.*overloaded/ }).click();
  const call = page.getByRole('complementary', { name: 'Call inspector' });
  await call.getByText('Target declaration', { exact: true }).first().waitFor();
  const fn = page.getByRole('complementary', { name: 'Function inspector' });
  assert.equal(await call.getByText('Target declaration', { exact: true }).count(), 2);
  assert.equal(await call.getByText('Selected overload', { exact: true }).count(), 2);
  assert.equal(await call.locator('.evidence-list li').count(), 2);
  const sites = await call.locator('.evidence-list li code:first-of-type').allTextContents();
  assert.ok(sites.every(site => site.startsWith('app/consumer.ts:')));
  assert.notEqual(sites[0], sites[1]);
  await call.getByRole('button', { name: /overloaded.*lib\/service/ }).click();
  await fn.getByText('Direct callers', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back to files' }).click();
  await dependency.getByText('Resolved calls between files', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Functions', exact: true }).click();
  await fn.getByText('Direct callers', { exact: true }).waitFor();
  await fn.getByRole('button', { name: 'Open declaration file' }).click();
  await file.getByText('lib/service.ts', { exact: true }).waitFor();
  await file.getByRole('button', { name: 'Explore functions' }).click();
  await page.getByRole('heading', { name: 'Function calls' }).waitFor();
  await page.getByText('Partial function analysis', { exact: true }).waitFor();
  await search(page, 'arrow', /^arrow\(\).*app\/consumer/);
  await arranged(page);
  const arrow = data.functionGraph.nodes.find(node => node.qualifiedName === 'arrow').id;
  const step = data.functionGraph.nodes.find(node => node.qualifiedName === 'step').id;
  const arrowState = await canvasState(page);
  assert.ok(arrowState.edges.some(edge => edge.source === arrow && edge.target === step && edge.classes.includes('dependency')));
  assert.ok(arrowState.edges.some(edge => edge.target === arrow && edge.classes.includes('dependent')));
  await tapEdge(page, arrowState.edges.find(edge => edge.source === arrow && edge.target === step).id);
  await call.getByText('Call sites', { exact: true }).waitFor();
  await search(page, 'recurse');
  await arranged(page);
  assert.ok((await canvasState(page)).edges.some(edge => edge.loop && edge.drawable));
  await fn.getByRole('button', { name: /Inspect call to app\/consumer/ }).click();
  await call.getByText('Call sites', { exact: true }).waitFor();
  await search(page, 'dispatch');
  await fn.getByText('Unresolved and ambiguous calls', { exact: false }).click();
  await fn.getByText('Ambiguous', { exact: true }).waitFor();
  assert.equal(await fn.getByText('None recorded.', { exact: true }).count(), 2);
  await page.locator('.graph-surface').click({ position: { x: 10, y: 10 } });
  assert.equal(await fn.count(), 0);
  await page.getByRole('button', { name: 'Back to files' }).click();
  await file.getByText('lib/service.ts', { exact: true }).waitFor();
  await file.getByRole('button', { name: 'Close inspector' }).click();
  assert.equal(await file.count(), 0);
  await arranged(page);
  assert.deepEqual(errors, []);
});

test('sample, cycle filter, medium cap and canceled layouts', async t => {
  const { page, errors } = await open(t);
  await arranged(page);
  const canvases = await page.locator('.graph-surface canvas').count();
  assert.ok(canvases > 0);
  await chooseFolder(page, cycles);
  await page.getByLabel('Circular dependencies').selectOption('0');
  await arranged(page);
  assert.ok((await canvasState(page)).edges.every(edge => edge.classes.includes('cycle')));
  await search(page, 'node1.ts');
  await page.getByRole('complementary', { name: 'File inspector' }).getByText('Circular dependency', { exact: true }).waitFor();
  await page.locator('.graph-surface').click({ position: { x: 10, y: 10 } });
  await page.route('**/api/analyze', route => route.fulfill({ json: medium }));
  assert.equal((await analyze(page)).status(), 200);
  await page.getByText('Showing 90 of 200 files.', { exact: false }).waitFor();
  await arranged(page);
  const positions = (await canvasState(page)).nodes;
  assert.equal(positions.length, 90);
  for (let i = 0; i < positions.length; i++) {
    for (const other of positions.slice(i + 1)) {
      const a = positions[i].bounds, b = other.bounds;
      assert.ok(a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1, 'Nodes overlap');
    }
  }
  await search(page, medium.nodes.at(-1).id);
  await page.getByRole('complementary', { name: 'File inspector' }).getByText(medium.nodes.at(-1).id, { exact: true }).waitFor();
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Functions', exact: true }).click();
    await page.getByRole('button', { name: 'Back to files' }).click();
  }
  await arranged(page);
  assert.equal(await page.locator('.graph-surface canvas').count(), canvases);
  assert.equal(await page.evaluate(() => window.explorerWorkers.active), 0);
  assert.deepEqual(errors, []);
});

test('mixed-language local upload reports missing analyzer or shows native dependencies', async t => {
  const { page, errors } = await open(t);
  const data = await chooseFolder(page, mixed);
  assert.equal(data.languageCoverage.length, 7);
  await arranged(page);
  await page.getByText('Language coverage', { exact: false }).click();
  if (process.env.COCKPIT_ANALYZER_IMAGE) {
    assert.ok(data.edges.some(edge => edge.from === 'go/main.go' && edge.kind === 'import'));
    assert.ok(data.edges.some(edge => edge.from === 'java/src/app/Runner.java' && edge.kind === 'import'));
    await search(page, 'java/src/app/Runner.java');
    await page.getByRole('button', { name: 'Inspect dependency to java/src/other/Base.java' }).click();
    const inspector = page.getByRole('complementary', { name: 'Dependency inspector' });
    await inspector.getByRole('heading', { name: 'Import sites' }).waitFor();
    await inspector.getByRole('heading', { name: 'Reference sites' }).waitFor();
    await page.getByRole('button', { name: 'Functions', exact: true }).click();
    await search(page, 'Runner.text');
    await page.getByRole('button', { name: /Inspect call to java\/src\/app\/Runner.java/ }).click();
    const calls = page.getByRole('complementary', { name: 'Call inspector' });
    await calls.getByText('Target declaration').waitFor();
    await calls.getByText('Selected overload').waitFor();
    assert.deepEqual(errors, []);
    return;
  }
  await page.getByText(/Configure the Cockpit native analyzer image/).first().waitFor();
  assert.ok(!data.nodes.some(node => node.kind === 'package'));
  await search(page, 'python/pkg/main.py');
  const file = page.getByRole('complementary', { name: 'File inspector' });
  await file.getByText('Python', { exact: true }).waitFor();
  await file.getByText('Direct dependencies', { exact: true }).waitFor();
  assert.equal(await file.getByRole('button', { name: /Inspect dependency/ }).count(), 0);
  await page.getByRole('button', { name: 'Functions', exact: true }).click();
  assert.ok(data.functionGraph.nodes.every(node => ['javascript', 'typescript'].includes(node.language)));
  await page.getByRole('button', { name: 'Back to files' }).click();
  await file.waitFor();
  await arranged(page);
  assert.deepEqual(errors, []);
});

test('a Java file edge displays import and reference evidence together', async t => {
  const { page, errors } = await open(t);
  const from = 'java/Consumer.java';
  const to = 'java/Supplier.java';
  const site = { file: from, startColumn: 0, endColumn: 6 };
  await page.route('**/api/analyze', route => route.fulfill({ json: {
    nodes: [{ id: from, language: 'java' }, { id: to, language: 'java' }],
    edges: [{ from, to, kind: 'import', evidence: [{ ...site, startLine: 0, endLine: 0 }],
      additionalEvidence: { reference: [{ ...site, startLine: 2, endLine: 2 }] } }],
  } }));
  assert.equal((await analyze(page)).status(), 200);
  await search(page, from);
  await page.getByRole('button', { name: 'Inspect dependency to ' + to }).click();
  const inspector = page.getByRole('complementary', { name: 'Dependency inspector' });
  await inspector.getByRole('heading', { name: 'Import sites' }).waitFor();
  await inspector.getByRole('heading', { name: 'Reference sites' }).waitFor();
  assert.deepEqual(await inspector.locator('.source-location').allTextContents(), [
    from + ':1:1–1:7', from + ':3:1–3:7'
  ]);
  assert.deepEqual(errors, []);
});

test('handles incomplete and empty responses at a narrow viewport', async t => {
  const { page, errors } = await open(t, { viewport: { width: 420, height: 780 } });
  await arranged(page);
  await page.route('**/api/analyze', route => route.fulfill({ json: { nodes: [], edges: [] } }));
  await analyze(page);
  await page.getByText('No supported source files were found.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Functions', exact: true }).click();
  await page.getByText('Function analysis is unavailable for this result.', { exact: true }).waitFor();
  await page.unroute('**/api/analyze');
  await page.route('**/api/analyze', route => route.fulfill({ json: { nodes: false, edges: [] } }));
  await analyze(page);
  await page.getByRole('alert').getByText('The server returned an invalid dependency graph.').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 420);
  assert.deepEqual(errors, []);
});

test('layout failure falls back to a usable grid', async t => {
  const { page, errors } = await open(t, { workerFailure: true });
  await page.getByText('Layered layout unavailable. Showing a grid.').waitFor();
  await search(page, 'src/analysis.ts');
  await page.getByRole('complementary', { name: 'File inspector' }).waitFor();
  assert.equal(errors.filter(error => error.includes('Cockpit graph layout failed')).length, 1);
});

test('explicit expansion adds the next caller and callee level', async t => {
  const { page, errors } = await open(t);
  const range = { file: 'chain.ts', startLine: 0, startColumn: 0, endLine: 0, endColumn: 5 };
  const nodes = ['first', 'second', 'third', 'fourth'].map((name, i) => ({
    id: name, name, qualifiedName: name, file: 'chain.ts', kind: 'function',
    declaration: { ...range, startLine: i, endLine: i },
  }));
  const edges = nodes.slice(0, -1).map((node, i) => ({
    id: node.id + '-call', caller: node.id, callee: nodes[i + 1].id, kind: 'call',
    sites: [{ at: node.declaration, target: nodes[i + 1].declaration }],
  }));
  await page.route('**/api/analyze', route => route.fulfill({ json: {
    nodes: [{ id: 'chain.ts' }], edges: [], functionGraph: { nodes, edges, coverage: 'complete' },
  } }));
  await analyze(page);
  await page.getByRole('button', { name: 'Functions', exact: true }).click();
  await search(page, 'first');
  await arranged(page);
  assert.deepEqual((await canvasState(page)).nodes.map(node => node.id), ['first', 'second']);
  const started = await page.evaluate(() => window.explorerWorkers.started);
  await page.getByRole('button', { name: 'Expand neighborhood' }).click();
  await arranged(page);
  assert.ok((await canvasState(page)).nodes.some(node => node.id === 'third'));
  assert.equal(await page.evaluate(() => window.explorerWorkers.started), started + 1);
  await page.getByRole('button', { name: 'Expand neighborhood' }).click();
  await arranged(page);
  assert.ok((await canvasState(page)).nodes.some(node => node.id === 'fourth'));
  await page.locator('.graph-surface').click({ position: { x: 10, y: 10 } });
  await page.getByText('Search for a function or explore functions from a file.', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test('public GitHub ingestion returns both graphs', { skip: !process.env.COCKPIT_LIVE_GITHUB }, async t => {
  const { page, errors } = await open(t);
  const response = await analyze(page);
  assert.equal(response.status(), 200, await response.text());
  const graph = await response.json();
  assert.ok(graph.nodes.length && graph.edges.length && graph.functionGraph.nodes.length);
  await arranged(page);
  await search(page, 'index.js');
  await page.getByRole('complementary', { name: 'File inspector' }).waitFor();
  assert.deepEqual(errors, []);
});

