const assert = require('assert');
const http = require('http');
const path = require('node:path');
const fs = require('node:fs/promises');
const AdmZip = require('adm-zip');
const git = require('simple-git');
const originalGit = git.simpleGit;
const fixture = path.resolve(__dirname, '../../core/test/fixtures/multilang');
const fixtureUrl = 'https://github.com/cockpit-test/native-fixture.git';
// Exercise the GitHub route with a repeatable checkout containing an mixed-language source.
require.cache[require.resolve('simple-git')].exports = { ...git, simpleGit: (...args) => ({
  clone: (url, target, options) => url === fixtureUrl ? fs.cp(fixture, target, { recursive: true })
    : originalGit(...args).clone(url, target, options)
}) };
const app = require('../src/index');
require.cache[require.resolve('simple-git')].exports = git;

async function runTests() {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`Running server tests on ${baseUrl}...`);

  try {
    // 1. Health check
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.strictEqual(healthRes.status, 200, 'Health check should return 200');
    const healthJson = await healthRes.json();
    assert.strictEqual(healthJson.status, 'ok');
    console.log('✓ Health check passed');

    // 2. Reject missing body on /api/analyze
    const emptyRes = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.strictEqual(emptyRes.status, 400, 'Empty body should return 400');
    console.log('✓ Rejection of empty body passed (400)');

    // 3. Reject malformed / command injection URL
    const malformedRes = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl: 'https://evil.com/repo; rm -rf /' })
    });
    assert.strictEqual(malformedRes.status, 400, 'Malformed URL should return 400');
    console.log('✓ Rejection of malformed URL passed (400)');

    // 4. Non-existent GitHub repository (422)
    const notFoundRes = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl: 'https://github.com/nonexistent-owner-abc1234/nonexistent-repo-xyz987' })
    });
    assert.strictEqual(notFoundRes.status, 422, 'Non-existent repo should return 422');
    console.log('✓ Non-existent repo clone failure passed (422)');

    // 5. Upload endpoint: reject missing file
    const noFileRes = await fetch(`${baseUrl}/api/analyze-upload`, {
      method: 'POST',
      body: new FormData()
    });
    assert.strictEqual(noFileRes.status, 400, 'Upload without file should return 400');
    console.log('✓ Upload without file rejected (400)');

    // 6. Upload endpoint: reject invalid zip buffer
    const badFormData = new FormData();
    badFormData.append('bundle', new Blob(['not a real zip'], { type: 'application/zip' }), 'test.zip');
    const badZipRes = await fetch(`${baseUrl}/api/analyze-upload`, {
      method: 'POST',
      body: badFormData
    });
    assert.strictEqual(badZipRes.status, 400, 'Corrupt zip buffer should return 400');
    console.log('✓ Corrupt zip buffer rejected (400)');

    // 7. Upload endpoint: reject zip-slip path traversal attempt
    const slipZip = new AdmZip();
    slipZip.addFile('dummy.js', Buffer.from('console.log("evil");'));
    slipZip.getEntries()[0].entryName = '../../evil.js';
    const slipBuffer = slipZip.toBuffer();
    const slipFormData = new FormData();
    slipFormData.append('bundle', new Blob([slipBuffer], { type: 'application/zip' }), 'slip.zip');
    const slipRes = await fetch(`${baseUrl}/api/analyze-upload`, {
      method: 'POST',
      body: slipFormData
    });
    assert.strictEqual(slipRes.status, 400, 'Zip-slip attempt should be rejected with 400');
    console.log('✓ Zip-slip path traversal attempt rejected (400)');

    // 8. Upload endpoint: valid zip upload of a project
    const validZip = new AdmZip();
    validZip.addFile('tsconfig.json', Buffer.from(JSON.stringify({ compilerOptions: { paths: { '@util': ['./src/util'] } } })));
    validZip.addFile('src/index.ts', Buffer.from("import { util } from '@util';\nexport const entry = () => util() + util();"));
    validZip.addFile('src/util.ts', Buffer.from("import { entry } from './index';\nexport function util(): number { return entry(); }"));
    const validBuffer = validZip.toBuffer();

    const validFormData = new FormData();
    validFormData.append('bundle', new Blob([validBuffer], { type: 'application/zip' }), 'project.zip');

    const validUploadRes = await fetch(`${baseUrl}/api/analyze-upload`, {
      method: 'POST',
      body: validFormData
    });
    assert.strictEqual(validUploadRes.status, 200, `Valid zip upload should return 200, got ${validUploadRes.status}`);
    const validData = await validUploadRes.json();
    assert.deepStrictEqual(Object.keys(validData).sort(), ['analysis', 'edges', 'functionGraph', 'nodes', 'symbolUsage']);
    assert.deepStrictEqual(validData.nodes.map(node => node.id), ['src/index.ts', 'src/util.ts']);
    assert.ok(validData.nodes.every(node => node.path === node.id));
    assert.deepStrictEqual(validData.edges, [
      { from: 'src/index.ts', to: 'src/util.ts' },
      { from: 'src/util.ts', to: 'src/index.ts' }
    ]);
    assert.deepStrictEqual(validData.analysis, { cycles: [['src/index.ts', 'src/util.ts']] });
    assert.ok(validData.symbolUsage.some(usage =>
      usage.importedSymbol === 'util' && usage.usedInFile === 'src/index.ts' &&
      usage.fromFile === 'src/util.ts' && usage.usedInScope === 'entry' && usage.line === 2
    ), 'Should include symbol-reference evidence for the importing file');
    const { functionGraph } = validData;
    assert.strictEqual(functionGraph.coverage, 'complete');
    assert.strictEqual(functionGraph.nodes.length, 2);
    assert.strictEqual(functionGraph.edges.length, 2);
    const entry = functionGraph.nodes.find(node => node.name === 'entry');
    const util = functionGraph.nodes.find(node => node.name === 'util');
    const invocation = functionGraph.edges.find(edge => edge.caller === entry.id && edge.callee === util.id);
    assert.deepStrictEqual(invocation.sites.map(site => site.at.startColumn), [27, 36]);
    assert.ok(invocation.sites.every(site => site.at.file === 'src/index.ts' && site.target.file === 'src/util.ts'));
    console.log('✓ Valid zip upload returned the file cycle, symbol references, and both call sites');

    const shadowed = new AdmZip();
    shadowed.addFile('target.js', Buffer.from('exports.value = 1;'));
    shadowed.addFile('legitimate.cjs', Buffer.from("module.exports = require('./target.js');"));
    shadowed.addFile('local.js', Buffer.from("function require(x) { return x; }\nexports.call = () => require('./target.js');"));
    shadowed.addFile('local.ts', Buffer.from("export function run(require: (x: string) => string) { return require('./target.js'); }"));
    shadowed.addFile('esm.ts', Buffer.from("import './target.js';"));
    const shadowForm = new FormData();
    shadowForm.append('bundle', new Blob([shadowed.toBuffer()]), 'shadowed.zip');
    const shadowResponse = await fetch(`${baseUrl}/api/analyze-upload`, { method: 'POST', body: shadowForm });
    assert.strictEqual(shadowResponse.status, 200);
    const shadowGraph = await shadowResponse.json();
    assert.deepStrictEqual(shadowGraph.edges, [
      { from: 'esm.ts', to: 'target.js' }, { from: 'legitimate.cjs', to: 'target.js' }
    ]);
    const shadowedFunction = shadowGraph.functionGraph.nodes.find(node => node.name === 'require' && node.file === 'local.js');
    assert.ok(shadowedFunction && shadowGraph.functionGraph.edges.some(edge => edge.callee === shadowedFunction.id));

    const mixedZip = new AdmZip();
    mixedZip.addLocalFolder(fixture);
    const mixedForm = new FormData();
    mixedForm.append('bundle', new Blob([mixedZip.toBuffer()], { type: 'application/zip' }), 'mixed.zip');
    const mixedResponse = await fetch(`${baseUrl}/api/analyze-upload`, { method: 'POST', body: mixedForm });
    assert.strictEqual(mixedResponse.status, 200);
    const mixed = await mixedResponse.json();
    assert.strictEqual(mixed.languageCoverage.length, 7);
    assert.ok(mixed.languageCoverage.some(item => item.language === 'python' && item.status === 'unavailable'));
    function assertUnavailable(graph) {
      assert.ok(graph.languageCoverage.some(item => item.language === 'python'
        && item.status === 'unavailable' && item.diagnostics.some(message => message.includes('native analyzer image'))));
      assert.ok(!graph.nodes.some(node => node.kind === 'package'));
      assert.deepStrictEqual(graph.edges, [{ from: 'main.ts', to: 'helper.ts' }]);
      assert.ok(graph.functionGraph.nodes.length > 0);
      assert.ok(graph.functionGraph.nodes.every(node => ['typescript', 'javascript'].includes(node.language)));
    }
    assertUnavailable(mixed);
    assert.ok(mixed.nodes.filter(node => !node.kind).every(node => node.id === node.path && !path.isAbsolute(node.path)));
    const checkout = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoUrl: fixtureUrl })
    });
    assert.strictEqual(checkout.status, 200);
    assertUnavailable(await checkout.json());
    if (process.env.COCKPIT_TEST_ANALYZER_IMAGE) {
      const previous = process.env.COCKPIT_ANALYZER_IMAGE;
      process.env.COCKPIT_ANALYZER_IMAGE = process.env.COCKPIT_TEST_ANALYZER_IMAGE;
      try {
        const form = new FormData();
        form.append('bundle', new Blob([mixedZip.toBuffer()]), 'controlled.zip');
        const results = await Promise.all([
          fetch(`${baseUrl}/api/analyze-upload`, { method: 'POST', body: form }),
          fetch(`${baseUrl}/api/analyze`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoUrl: fixtureUrl })
          })
        ]);
        for (const result of results) {
          assert.strictEqual(result.status, 200);
          const graph = await result.json();
          for (const lang of ['c', 'cpp', 'go', 'java', 'python']) {
            assert.ok(graph.languageCoverage.some(item => item.language === lang && item.status === 'partial'),
              JSON.stringify(graph.languageCoverage));
          }
          assert.ok(graph.edges.some(edge => edge.from === 'go/main.go' && edge.kind === 'import'));
          const java = graph.edges.find(edge => edge.from === 'java/src/app/Runner.java' && edge.kind === 'import');
          assert.ok(java?.additionalEvidence?.reference?.length);
          assert.ok(graph.edges.some(edge => edge.from === 'python/pkg/main.py' && edge.kind === 'import'));
          assert.ok(graph.edges.some(edge => edge.from === 'native/run.c' && edge.kind === 'include'));
          const byId = new Map(graph.functionGraph.nodes.map(node => [node.id, node]));
          const calls = (name, file) => graph.functionGraph.edges.filter(edge =>
            byId.get(edge.callee)?.name === name && edge.sites[0].at.file === file);
          assert.equal(calls('Leaf', 'go/main.go')[0].sites.length, 2);
          assert.deepEqual(calls('leaf', 'python/pkg/main.py').find(edge => edge.sites.length === 2)
            .sites.map(site => site.at.startColumn), [20, 31]);
          const overloads = calls('leaf', 'java/src/app/Runner.java');
          assert.equal(new Set(overloads.map(edge => edge.callee)).size, 2);
          assert.ok(overloads.every(edge => edge.sites[0].signature));
          assert.equal(calls('leaf', 'native/run.c')[0].sites.length, 2);
          assert.ok(calls('Constructed', 'native/main.cpp').some(edge => edge.kind === 'construct'));
          assert.ok(calls('qualified', 'native/main.cpp').length);
          assert.ok(calls('fn', 'native/main.cpp').some(edge => edge.sites[0].signature));
          assert.ok(calls('static', 'python/pkg/main.py').some(edge => byId.get(edge.caller)?.name === 'member'));
          assert.ok(!graph.functionGraph.edges.some(edge =>
            ['Dynamic', 'dispatch', 'indirect', 'dynamic'].includes(byId.get(edge.caller)?.name)));
          assert.ok(graph.functionGraph.unresolved.some(call => call.at.file === 'go/main.go'));
          assert.ok(graph.functionGraph.unresolved.some(call => call.at.file === 'java/src/app/Runner.java'));
          assert.ok(graph.functionGraph.unresolved.some(call => call.at.file === 'native/leaf.c'));
          assert.ok(graph.functionGraph.unresolved.some(call => call.at.file === 'python/pkg/main.py'));
        }
      } finally {
        if (previous === undefined) delete process.env.COCKPIT_ANALYZER_IMAGE;
        else process.env.COCKPIT_ANALYZER_IMAGE = previous;
      }
    }

    // 9. Upload endpoint: reject zip exceeding file count cap (413)
    const tooManyFilesZip = new AdmZip();
    for (let i = 0; i <= 5000; i++) {
      tooManyFilesZip.addFile(`file_${i}.ts`, Buffer.from(''));
    }
    const tooManyBuffer = tooManyFilesZip.toBuffer();
    const tooManyFormData = new FormData();
    tooManyFormData.append('bundle', new Blob([tooManyBuffer], { type: 'application/zip' }), 'too-many.zip');
    const tooManyRes = await fetch(`${baseUrl}/api/analyze-upload`, {
      method: 'POST',
      body: tooManyFormData
    });
    assert.strictEqual(tooManyRes.status, 413, 'Zip with >5000 files should be rejected with 413');
    const tooManyJson = await tooManyRes.json();
    assert.ok(tooManyJson.error.includes('too many files'), 'Error message should mention too many files');
    console.log('✓ File count limit cap rejected cleanly (413)');

    // 10. Upload endpoint: reject file exceeding size cap (413)
    // Spawn temporary app instance with lower size cap to test multer rejection cleanly
    const savedLimit = process.env.MAX_UPLOAD_SIZE;
    process.env.MAX_UPLOAD_SIZE = '1024'; // 1KB limit
    delete require.cache[require.resolve('../src/index')];
    const lowCapApp = require('../src/index');
    const lowCapServer = http.createServer(lowCapApp);
    await new Promise(res => lowCapServer.listen(0, res));
    const lowCapUrl = `http://127.0.0.1:${lowCapServer.address().port}`;

    try {
      const oversizedForm = new FormData();
      oversizedForm.append('bundle', new Blob([Buffer.alloc(2048, 'x')], { type: 'application/zip' }), 'big.zip');
      const oversizedRes = await fetch(`${lowCapUrl}/api/analyze-upload`, {
        method: 'POST',
        body: oversizedForm
      });
      assert.strictEqual(oversizedRes.status, 413, 'Oversized file should be rejected with 413');
      const oversizedJson = await oversizedRes.json();
      assert.ok(oversizedJson.error.includes('exceeds the maximum size limit'), 'Error message should mention size limit');
      console.log('✓ File size limit cap rejected cleanly (413)');
      const expandedZip = new AdmZip();
      expandedZip.addFile('expanded.py', Buffer.alloc(2048, 'x'));
      const expandedForm = new FormData();
      expandedForm.append('bundle', new Blob([expandedZip.toBuffer()], { type: 'application/zip' }), 'expanded.zip');
      const expandedRes = await fetch(`${lowCapUrl}/api/analyze-upload`, { method: 'POST', body: expandedForm });
      assert.strictEqual(expandedRes.status, 413);
      assert.match((await expandedRes.json()).error, /Expanded zip/);
    } finally {
      lowCapServer.close();
      if (savedLimit !== undefined) {
        process.env.MAX_UPLOAD_SIZE = savedLimit;
      } else {
        delete process.env.MAX_UPLOAD_SIZE;
      }
      delete require.cache[require.resolve('../src/index')];
    }

    console.log('\nAll server unit tests passed successfully! ✓');
  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
