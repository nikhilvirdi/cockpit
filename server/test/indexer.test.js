const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { indexProvider } = require('../src/indexer');

test('isolated provider is opt-in and reports invalid configuration, missing Docker and cancellation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-index-test-'));
  const previous = process.env.COCKPIT_SCIP_GO_IMAGE;
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const originalPath = process.env[pathKey];
  const run = indexProvider(dir);
  const project = { root: dir, language: 'go' };
  try {
    delete process.env.COCKPIT_SCIP_GO_IMAGE;
    assert.equal(await run(project), undefined);
    process.env.COCKPIT_SCIP_GO_IMAGE = 'unpinned:latest';
    await assert.rejects(run(project), /SHA-256/);
    process.env.COCKPIT_SCIP_GO_IMAGE = 'sha256:' + '0'.repeat(64);
    process.env[pathKey] = dir;
    await assert.rejects(run(project), /Docker executable is unavailable/);
    await assert.rejects(run(project, AbortSignal.abort()), { name: 'AbortError' });
    assert.deepEqual(await fs.readdir(dir), []);
  } finally {
    if (originalPath !== undefined) process.env[pathKey] = originalPath;
    else delete process.env[pathKey];
    if (previous !== undefined) process.env.COCKPIT_SCIP_GO_IMAGE = previous;
    else delete process.env.COCKPIT_SCIP_GO_IMAGE;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('live isolated provider collects an index and cleans up unsuccessful containers', {
  skip: !process.env.COCKPIT_TEST_INDEXER_IMAGE
}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-index-test-'));
  const previous = process.env.COCKPIT_SCIP_GO_IMAGE;
  const project = { root: dir, language: 'go' };
  const marker = path.join(dir, 'mode');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-index-output-'));
  process.env.COCKPIT_SCIP_GO_IMAGE = process.env.COCKPIT_TEST_INDEXER_IMAGE;
  try {
    const bytes = await fs.readFile(path.resolve(__dirname, '../../core/test/fixtures/multilang/go/index.scip'));
    await fs.writeFile(path.join(dir, 'fixture.scip'), bytes);
    const run = indexProvider(output);
    const index = await run(project);
    assert.deepEqual(await fs.readFile(index), bytes);
    await fs.writeFile(marker, 'failure');
    await assert.rejects(run(project), /exited unsuccessfully/);
    await fs.writeFile(marker, 'sleep');
    await assert.rejects(run(project, AbortSignal.timeout(1500)), { name: 'TimeoutError' });
    await assert.rejects(run(project), /indexer timed out/);
    const containers = execFileSync('docker', ['ps', '-a', '--filter', 'name=cockpit-scip-', '--format', '{{.Mounts}}'], { encoding: 'utf8' });
    assert.ok(!containers.includes(path.basename(dir)), 'The test container should be removed');
    assert.deepEqual(await fs.readdir(output), [path.basename(index)]);
  } finally {
    if (previous !== undefined) process.env.COCKPIT_SCIP_GO_IMAGE = previous;
    else delete process.env.COCKPIT_SCIP_GO_IMAGE;
    await fs.rm(output, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
  }
});
