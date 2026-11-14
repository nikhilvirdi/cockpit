const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { nativeProvider } = require('../src/native-runner');

test('isolated provider is opt-in and reports invalid configuration, missing Docker and cancellation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-native-test-'));
  const previous = process.env.COCKPIT_ANALYZER_IMAGE;
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const originalPath = process.env[pathKey];
  const run = nativeProvider(dir);
  try {
    delete process.env.COCKPIT_ANALYZER_IMAGE;
    assert.equal(await run(dir, 'go'), undefined);
    process.env.COCKPIT_ANALYZER_IMAGE = 'unpinned:latest';
    await assert.rejects(run(dir, 'go'), /SHA-256/);
    process.env.COCKPIT_ANALYZER_IMAGE = 'sha256:' + '0'.repeat(64);
    process.env[pathKey] = dir;
    await assert.rejects(run(dir, 'go'), /Docker executable is unavailable/);
    await assert.rejects(run(dir, 'go', AbortSignal.abort()), { name: 'AbortError' });
    assert.deepEqual(await fs.readdir(dir), []);
  } finally {
    if (originalPath !== undefined) process.env[pathKey] = originalPath;
    else delete process.env[pathKey];
    if (previous !== undefined) process.env.COCKPIT_ANALYZER_IMAGE = previous;
    else delete process.env.COCKPIT_ANALYZER_IMAGE;
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test('analyzer failures, cancellations and timeouts terminate their container', {
  skip: !process.env.COCKPIT_TEST_TIMEOUT_IMAGE
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-runner-test-'));
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-runner-output-'));
  const previous = process.env.COCKPIT_ANALYZER_IMAGE;
  try {
    process.env.COCKPIT_ANALYZER_IMAGE = process.env.COCKPIT_TEST_TIMEOUT_IMAGE;
    const run = nativeProvider(output);
    await fs.writeFile(path.join(root, 'mode'), 'failure');
    await assert.rejects(run(root, 'go'), /exited unsuccessfully/);
    await fs.writeFile(path.join(root, 'mode'), 'sleep');
    await assert.rejects(run(root, 'go', AbortSignal.timeout(1500)), { name: 'TimeoutError' });
    await assert.rejects(run(root, 'go'), /analyzer timed out/);
    const containers = execFileSync('docker', ['ps', '-a', '--filter', 'name=cockpit-native-', '--format', '{{.Mounts}}'], { encoding: 'utf8' });
    assert.ok(!containers.includes(path.basename(output)));
    assert.deepEqual(await fs.readdir(output), []);
  } finally {
    if (previous !== undefined) process.env.COCKPIT_ANALYZER_IMAGE = previous;
    else delete process.env.COCKPIT_ANALYZER_IMAGE;
    await fs.rm(output, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Go resolves a nested module using its actual local replacement', {
  skip: !process.env.COCKPIT_TEST_ANALYZER_IMAGE
}, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-go-test-'));
  const previous = process.env.COCKPIT_ANALYZER_IMAGE;
  try {
    process.env.COCKPIT_ANALYZER_IMAGE = process.env.COCKPIT_TEST_ANALYZER_IMAGE;
    const run = () => require('@cockpit/core').analyzeWorkspace(path.resolve(__dirname, '../../core/test/fixtures/nested-go'),
      { analyzeNative: nativeProvider(temp) });
    const graph = await run();
    assert.deepEqual(await run(), graph);
    assert.ok(graph.nodes.some(node => node.kind === 'package' && node.name === 'example.com/cockpit-fixture/lib'));
    assert.ok(graph.edges.some(edge => edge.from === 'main.go' && edge.to.startsWith('package:go:')));
    assert.ok(!graph.edges.some(edge => edge.from === 'main.go' && edge.to === 'lib/lib.go'));
    assert.ok(graph.functionGraph.edges.some(edge => edge.sites[0].target.file === 'lib/lib.go'));
    const missing = await fs.mkdtemp(path.join(temp, 'missing-'));
    const source = path.join(missing, 'source');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'go.mod'), 'module example.com/missing\ngo 1.26\nrequire example.invalid/missing v1.0.0\n');
    await fs.writeFile(path.join(source, 'main.go'), 'package main\nimport "example.invalid/missing"\nfunc main(){missing.Run()}\n');
    const incomplete = await require('@cockpit/core').analyzeWorkspace(source, { analyzeNative: nativeProvider(temp) });
    assert.equal(incomplete.edges.length, 0);
    assert.equal(incomplete.functionGraph.edges.length, 0);
    assert.match(incomplete.languageCoverage[0].diagnostics.join(' '), /missing offline dependencies/);
  } finally {
    if (previous !== undefined) process.env.COCKPIT_ANALYZER_IMAGE = previous;
    else delete process.env.COCKPIT_ANALYZER_IMAGE;
    await fs.rm(temp, { recursive: true, force: true });
  }
});
