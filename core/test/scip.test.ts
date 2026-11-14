import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeWorkspace } from '../src';
import { readIndex } from '../src/scip';
import { openParser, readSyntax, sourcePositions } from '../src/scipSyntax';
import { isSourceFile } from '../src/scanner';

export async function testScip() {
  const root = path.join(__dirname, 'fixtures/multilang');
  const graph = await analyzeWorkspace(root);
  assert.deepEqual(await analyzeWorkspace(root), graph);
  assert.deepEqual(graph.languageCoverage?.map(item => [item.language, item.status]), [
    ['c', 'partial'], ['cpp', 'partial'], ['go', 'partial'], ['java', 'partial'],
    ['javascript', 'complete'], ['python', 'partial'], ['typescript', 'complete']
  ]);
  assert.equal(graph.functionGraph.coverage, 'partial');
  const fileGraph = graph.nodes;
  assert.ok(fileGraph.some(node => node.id === 'native/leaf.h'));
  assert.ok(fileGraph.some(node => node.id === 'python/pkg/__init__.py'));
  assert.ok(fileGraph.filter(node => !node.kind).every(node => node.path === node.id && !node.id.includes('\\')));
  assert.equal(new Set(fileGraph.map(node => node.id)).size, fileGraph.length);
  const goPackage = fileGraph.find(node => node.kind === 'package');
  assert.equal(goPackage?.path, 'example.com/cockpit-fixture/lib');
  assert.deepEqual(graph.edges.map(edge => [edge.from, edge.to, edge.kind]), [
    ['go/main.go', goPackage!.id, 'import'],
    ['java/src/Runner.java', 'java/src/other/Base.java', 'import'],
    ['main.ts', 'helper.ts', undefined],
    ['native/leaf.c', 'native/leaf.h', 'include'],
    ['native/main.cpp', 'native/leaf.h', 'include'],
    ['native/run.c', 'native/leaf.h', 'include'],
    ['python/pkg/main.py', 'python/pkg/helpers.py', 'import']
  ]);
  assert.ok(graph.edges.filter(edge => edge.kind).every(edge => edge.evidence?.every(at => at.file === edge.from)));

  const functions = graph.functionGraph;
  assert.equal(new Set(functions.nodes.map(node => node.id)).size, functions.nodes.length);
  assert.equal(new Set(functions.edges.map(edge => edge.id)).size, functions.edges.length);
  const byId = new Map(functions.nodes.map(node => [node.id, node]));
  const calls = (language: string, caller: string, callee: string) => {
    const result = functions.edges.find(edge => byId.get(edge.caller)?.language === language
      && byId.get(edge.caller)?.qualifiedName === caller && byId.get(edge.callee)?.qualifiedName === callee);
    assert.ok(result, [language, caller, callee].join(' '));
    assert.ok(result.sites.every(site => site.at.file === byId.get(result.caller)?.file));
    assert.ok(result.sites.every(site => site.target.file === byId.get(result.callee)?.file));
    return result;
  };

  assert.deepEqual(calls('python', 'run', 'leaf').sites.map(site => [site.at.startColumn, site.at.endColumn]), [[20, 28], [31, 39]]);
  assert.equal(calls('python', 'construct', 'Example.__init__').kind, 'construct');
  calls('python', 'member', 'Example.static');
  calls('python', 'nested', 'nested.local');
  calls('python', 'recursive', 'recursive');
  assert.equal(calls('go', 'Run', 'Leaf').sites.length, 2);
  calls('go', 'Recur', 'Recur');
  calls('go', 'Concrete', 'Worker.Work');
  assert.equal(calls('java', 'Runner.create', 'Runner.Runner').kind, 'construct');
  assert.equal(calls('java', 'Runner.Runner', 'Base.Base').kind, 'construct');
  calls('java', 'Runner.run', 'Base.inherited');
  assert.notEqual(calls('java', 'Runner.run', 'Runner.leaf').callee, calls('java', 'Runner.text', 'Runner.leaf').callee);
  assert.equal(calls('java', 'Runner.text', 'Runner.leaf').sites[0].signature?.startLine, 5);
  calls('c', 'leaf', 'leaf');
  calls('c', 'run', 'twice');
  assert.equal(calls('c', 'twice', 'leaf').sites.length, 2);
  calls('cpp', 'fixture.run', 'fixture.passthrough');
  assert.equal(calls('cpp', 'fixture.run', 'fixture.fn').sites[0].target.startLine, 4);
  assert.equal(calls('cpp', 'fixture.run', 'fixture.fn').sites[0].signature?.startLine, 4);
  calls('cpp', 'fixture.concrete', 'fixture.Value.method');
  assert.equal(calls('cpp', 'fixture.construct', 'fixture.Constructed.Constructed').kind, 'construct');
  calls('javascript', 'runJs', 'getValue');
  calls('typescript', 'run', 'value');
  for (const [name, status] of [
    ['dynamic', 'unresolved'], ['Dynamic', 'ambiguous'], ['Runner.dispatch', 'ambiguous'],
    ['indirect', 'unresolved'], ['fixture.dispatch', 'ambiguous']
  ]) {
    const call = functions.unresolved.find(item => item.caller && byId.get(item.caller)?.qualifiedName === name);
    assert.equal(call?.status, status, name);
    assert.ok(call?.reason);
    assert.ok(!functions.edges.some(edge => edge.caller === call?.caller), name);
  }
  const pythonCandidates = functions.unresolved.filter(call => call.caller
    && byId.get(call.caller)?.name === 'dynamic_members').flatMap(call => call.candidates ?? []);
  assert.deepEqual(new Set(pythonCandidates.map(id => byId.get(id)?.qualifiedName)),
    new Set(['Example.get', 'Example.from_default']));

  for (const extension of ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'go', 'java', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx']) {
    assert.ok(isSourceFile('source.' + extension));
  }
  const positions = sourcePositions('test.py', 'é🚀\r\ncall()');
  assert.equal(positions.offset(0, 6, 1), 3);
  assert.equal(positions.offset(0, 3, 2), 3);
  assert.equal(positions.offset(0, 2, 3), 3);
  assert.equal(positions.offset(0, 3, 1), undefined);
  assert.equal(positions.offset(0, 2, 2), undefined);
  assert.equal(positions.offset(1, 0, 1), 5);
  const parser = await openParser('python');
  const tree = parser.parse('def (');
  try {
    assert.ok(tree && readSyntax(tree, 'python').hasErrors);
  } finally {
    tree?.delete();
    parser.delete();
  }

  const invalid = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-scip-test-'));
  try {
    for (const name of ['python', 'native', 'go', 'child']) fs.mkdirSync(path.join(invalid, name));
    const source = (name: string, content: string) => fs.writeFileSync(path.join(invalid, name), content);
    source('python/test.py', 'print(1)');
    source('python/index.scip', '\xff\xff');
    source('native/test.c', 'int foo(void) { return 1; }');
    source('native/compile_commands.json', '{}');
    source('go/main.go', 'package main');
    source('go/go.mod', 'module example.com/test');
    source('child/main.go', 'package main');
    source('child/go.mod', 'module example.com/child');
    source('go.work', 'go 1.27\nuse (\n ./go\n ./child\n)\n');
    source('main.ts', 'export function hello() {}');
    await assert.rejects(readIndex(path.join(invalid, 'python/index.scip')), /Malformed SCIP/);
    const attempted: string[] = [];
    const subset = await analyzeWorkspace(invalid, { provideIndex: async project => {
      attempted.push(path.basename(project.root));
      if (path.basename(project.root) === 'child') throw new Error('The isolated indexer failed.');
      return undefined;
    } });
    assert.deepEqual(attempted, ['child', 'go']);
    assert.deepEqual(subset.languageCoverage?.map(item => [item.language, item.root, item.status]), [
      ['c', 'native', 'unavailable'], ['go', 'child', 'unavailable'], ['go', 'go', 'unavailable'],
      ['python', 'python', 'unavailable'], ['typescript', '.', 'complete']
    ]);
    const diagnostics = JSON.stringify(subset.languageCoverage);
    assert.match(diagnostics, /compilation database is invalid/);
    assert.match(diagnostics, /isolated indexer failed/);
    assert.match(diagnostics, /No scip-go index/);
    assert.match(diagnostics, /Malformed SCIP/);
    assert.ok(!diagnostics.includes(invalid));
    assert.equal(subset.functionGraph.nodes[0]?.name, 'hello');
    await assert.rejects(analyzeWorkspace(invalid, { signal: AbortSignal.abort() }), { name: 'AbortError' });
    fs.copyFileSync(path.join(root, 'go/index.scip'), path.join(invalid, 'go/scip-go.scip'));
    fs.copyFileSync(path.join(root, 'go/main.go'), path.join(invalid, 'go/main.go'));
    fs.cpSync(path.join(root, 'go/lib'), path.join(invalid, 'go/lib'), { recursive: true });
    fs.mkdirSync(path.join(invalid, 'go/pkg'));
    fs.cpSync(path.join(root, 'python/pkg'), path.join(invalid, 'go/pkg'), { recursive: true });
    fs.copyFileSync(path.join(root, 'python/index.scip'), path.join(invalid, 'go/scip-python.scip'));
    const shared = await analyzeWorkspace(invalid);
    for (const language of ['python', 'go']) {
      assert.equal(shared.languageCoverage?.find(item => item.language === language && item.root === 'go')?.status, 'partial');
    }
  } finally {
    fs.rmSync(invalid, { recursive: true, force: true });
  }
  console.log('SCIP workspace tests passed');
}
