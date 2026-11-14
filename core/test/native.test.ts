import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeWorkspace } from '../src';

export async function testNative() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-json-'));
  try {
    const content = 'def leaf(): pass\r\ndef call(): return "🚀" and leaf()\r\n';
    fs.writeFileSync(path.join(root, 'source.py'), content);
    const leaf = ['source.py', 0, 0, 0, 16];
    const caller = ['source.py', 1, 0, 1, 33];
    const site = ['source.py', 1, 27, 1, 33];
    const output = { bytes: Buffer.from(JSON.stringify({ version: 1, tool: 'jedi 0.19.2',
      files: [['source.py', 'python']], callables: [[leaf, 'leaf', 'function'], [caller, 'call', 'function']],
      calls: [[site, caller, leaf, 'call'], [site, caller, leaf, 'call'],
        [['../escape.py', 0, 0, 0, 1], null, leaf, 'call'], [site, caller, ['source.py', 0, 0, 0, 1], 'call']] })),
    sourceHashes: new Map([['source.py', createHash('sha256').update(content).digest('hex')]]) };
    const options = { analyzeNative: async () => output };
    const graph = await analyzeWorkspace(root, options);
    assert.deepEqual(await analyzeWorkspace(root, options), graph);
    assert.equal(graph.functionGraph.edges.length, 1);
    assert.equal(graph.functionGraph.edges[0].sites.length, 1);
    assert.equal(graph.functionGraph.edges[0].sites[0].at.startColumn, 28);
    assert.match(graph.languageCoverage![0].diagnostics.join(' '), /did not match/);
    fs.writeFileSync(path.join(root, 'source.py'), content.replace('and leaf()', 'and fake()'));
    const stale = await analyzeWorkspace(root, options);
    assert.equal(stale.functionGraph.edges.length, 0);
    assert.equal(stale.languageCoverage![0].status, 'unavailable');
    const missing = await analyzeWorkspace(root);
    assert.match(missing.languageCoverage![0].diagnostics.join(' '), /native analyzer image/);
    const invalid = await analyzeWorkspace(root, { analyzeNative: async () => ({ ...output, bytes: Buffer.from('{') }) });
    assert.match(invalid.languageCoverage![0].diagnostics.join(' '), /invalid or incompatible/);
    await assert.rejects(analyzeWorkspace(root, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Native analyzer protocol tests passed.');
}
