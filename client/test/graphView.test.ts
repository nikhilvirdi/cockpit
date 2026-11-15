import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readGraph } from '../src/graphData.ts';
import { filterFileList } from '../src/folderScanner.ts';
import { edgeKey, indexGraphs, location, NODE_LIMIT, projectGraph } from '../src/graphView.ts';

const selected = ['demo/build/compile_commands.json', 'demo/build/generated.cpp', 'demo/src/main.cpp']
  .map(webkitRelativePath => ({ webkitRelativePath, name: webkitRelativePath.split('/').at(-1) })) as unknown as FileList;
assert.deepEqual(filterFileList(selected).map(file => file.relativePath), ['build/compile_commands.json', 'src/main.cpp']);

const fixture = JSON.parse(readFileSync(new URL('./large-graph.json', import.meta.url), 'utf8'));
const large = indexGraphs(readGraph(fixture)).files;
const overview = projectGraph(large, undefined, 1);
assert.equal(overview.nodes.length, NODE_LIMIT);
assert.ok(overview.limited);
assert.deepEqual(projectGraph(large, undefined, 1), overview);
assert.ok(overview.edges.every(edge => overview.nodes.some(node => node.id === edge.source)
  && overview.nodes.some(node => node.id === edge.target)));
const last = large.nodes.at(-1)!.id;
assert.ok(projectGraph(large, [last], 1, [last]).nodes.some(node => node.id === last));

const range = { file: 'a.ts', startLine: 0, startColumn: 3, endLine: 0, endColumn: 15 };
const callable = (id: string, file: string) => ({ id, name: 'run', qualifiedName: 'run', kind: 'unknown', file,
  declaration: { ...range, file } });
const call = (id: string, caller: string, callee: string) => ({ id, caller, callee, kind: 'call',
  sites: [{ at: range, target: range }, { at: { ...range, startLine: 1, endLine: 1 }, target: range }] });
const graph = readGraph({
  nodes: [{ id: 'a.ts' }, { id: 'nested/b.ts' }, { id: 'c.ts' }, { id: 'd.ts' }],
  edges: [{ from: 'a.ts', to: 'nested/b.ts' }, { from: 'nested/b.ts', to: 'a.ts' }, { from: 'unavailable', to: 'a.ts' }],
  analysis: { cycles: [['a.ts', 'nested/b.ts']] },
  functionGraph: {
    nodes: [callable('A', 'a.ts'), callable('B', 'nested/b.ts'), callable('C', 'c.ts'), callable('D', 'd.ts')],
    edges: [call('loop', 'A', 'A'), call('ab', 'A', 'B'), call('bc', 'B', 'C'), call('da', 'D', 'A'), call('bad', 'A', 'missing')],
    coverage: 'complete',
    unresolved: [{ status: 'ambiguous', caller: 'A', at: range, reason: 'Dynamic dispatch', candidates: ['C'] }],
  },
});
const indexed = indexGraphs(graph);
assert.equal(graph.functionGraph?.coverage, 'partial');
assert.equal(graph.edges.length, 2);
assert.equal(indexed.callsByFilePair.get(edgeKey('a.ts', 'nested/b.ts'))?.[0].id, 'ab');
assert.ok(indexed.files.byEdge.get(edgeKey('a.ts', 'nested/b.ts'))?.cycle);
assert.equal(indexed.functions.byId.get('A')?.label, indexed.functions.byId.get('B')?.label);
const dualEvidence = indexGraphs(readGraph({
  nodes: [{ id: 'a.ts' }, { id: 'b.ts' }],
  edges: [{ from: 'a.ts', to: 'b.ts', kind: 'import', evidence: [range],
    additionalEvidence: { reference: [{ ...range, startLine: 1, endLine: 1 }, {}] } }]
})).files;
assert.equal(dualEvidence.edges.length, 1);
assert.deepEqual(dualEvidence.edges[0].evidence, [range]);
assert.deepEqual(dualEvidence.edges[0].additionalEvidence?.reference, [{ ...range, startLine: 1, endLine: 1 }]);
assert.notEqual(indexed.functions.byId.get('A')?.detail, indexed.functions.byId.get('B')?.detail);
const first = projectGraph(indexed.functions, ['A'], 1);
assert.deepEqual(first.nodes.map(node => node.id), ['A', 'B', 'D']);
assert.deepEqual(first.edges.map(edge => edge.id), ['loop', 'ab', 'da']);
assert.equal(first.edges[1].call?.sites.length, 2);
assert.ok(first.canExpand);
assert.ok(projectGraph(indexed.functions, ['A'], 2).nodes.some(node => node.id === 'C'));
assert.ok(!indexed.functions.byEdge.has('bad'));
assert.deepEqual(indexed.unresolvedByCaller.get('A')?.[0].candidates, ['C']);
assert.equal(location(range), 'a.ts:1:4–1:16');
assert.equal(location(), 'Location unavailable');
assert.throws(() => readGraph({ nodes: false, edges: [] }), /invalid dependency graph/);
assert.deepEqual(readGraph({ nodes: [], edges: [] }).nodes, []);
console.log('Graph projection and response validation passed.');

