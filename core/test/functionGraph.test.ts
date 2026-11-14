import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeDependencyGraph, buildDependencyGraph } from '../src';
import type { SourceRange } from '../src';

const fixture = path.resolve(__dirname, 'fixtures/function-project');
const graph = analyzeDependencyGraph(buildDependencyGraph(fixture));
const { functionGraph: calls } = graph;
const byId = new Map(calls.nodes.map(node => [node.id, node]));
const caller = (name: string) => calls.nodes.find(node => node.qualifiedName === name);
const outgoing = (name: string) => calls.edges.filter(edge => edge.caller === caller(name)?.id);
const edge = (from: string, to: string, file?: string) => {
  const match = outgoing(from).find(candidate => {
    const target = byId.get(candidate.callee);
    return target?.qualifiedName === to && (!file || target.file === file);
  });
  assert.ok(match, 'Expected ' + from + ' → ' + to);
  return match;
};

assert.equal(calls.nodes.length, byId.size);
assert.equal(calls.edges.length, new Set(calls.edges.map(item => item.id)).size);
assert.equal(calls.coverage, 'partial');
assert.ok(calls.diagnostics.some(item => item.code === 2307));
assert.ok(calls.diagnostics.some(item => item.code === 2769));
assert.ok(graph.edges.some(item => item.from === 'app/consumer.ts' && item.to === 'lib/index.ts'));
assert.ok(graph.symbolUsage.some(item => item.importedSymbol === 'forwarded' && item.usedInFile === 'app/consumer.ts'));
assert.ok(!graph.symbolUsage.some(item => item.importedSymbol === 'same' && item.usedInScope === 'nested'));

edge('arrow', 'step', 'lib/service.ts');
edge('step', 'leaf', 'lib/service.ts');
edge('named', 'arrow');
edge('unnamed', 'named');
edge('tools.work', 'unnamed');
edge('tools.arrow', 'leaf', 'lib/service.ts');
edge('wrappedCall', 'wrapped');
edge('wrapped', 'step', 'lib/service.ts');
edge('entry', 'entry.nested');
edge('entry.nested', 'entry.same');
edge('importedSame', 'same', 'lib/service.ts');
edge('entry', 'step', 'lib/service.ts');
edge('entry', 'leaf', 'lib/service.ts');
edge('recurse', 'recurse');
assert.equal(caller('unnamed')?.kind, 'function');
assert.equal(caller('arrow')?.kind, 'arrow');
assert.equal(caller('tools.work')?.kind, 'method');
assert.equal(caller('tools.arrow')?.kind, 'arrow');
assert.ok(outgoing('entry').some(item => byId.get(item.callee)?.file === 'lib/service.ts' &&
  byId.get(item.callee)?.name.startsWith('<anonymous@')));
const iife = calls.nodes.find(node => node.qualifiedName.startsWith('entry.<anonymous@'));
assert.ok(iife);
edge('entry', iife.qualifiedName);
edge(iife.qualifiedName, 'leaf', 'lib/service.ts');
assert.ok(calls.moduleCalls.some(site => byId.get(site.callee)?.qualifiedName === 'leaf'));
assert.ok(!calls.edges.some(item => ['unused', 'callback', 'referenced'].includes(byId.get(item.callee)!.name)));

assert.equal(edge('Child.constructor', 'Base.constructor').kind, 'construct');
assert.equal(edge('runClasses', 'Child.constructor').sites.length, 2);
assert.equal(edge('runClasses', 'Base.constructor').kind, 'construct');
edge('runClasses', 'Base.shared');
edge('runClasses', 'Child.own');
edge('runClasses', 'Child.field');
edge('Child.field', 'leaf', 'app/classes.ts');
edge('Child.own', 'Child.#privateWork');
assert.equal(edge('Child.own', 'Base.work').sites.length, 1);
assert.equal(edge('runClasses', 'Base.work').sites.length, 2);
edge('inheritedImplicit', 'Base.work');
edge('optionalMethod', 'Child.own');
assert.equal(caller('Base.shared')?.kind, 'static-method');
const overload = edge('entry', 'overloaded');
assert.deepEqual(overload.sites.map(site => site.signature?.startLine), [8, 7]);
assert.ok(overload.sites.every(site => site.target.startLine === 9));
assert.equal(calls.nodes.filter(node => node.name === 'overloaded').length, 1);
assert.equal(caller('runCjs')?.language, 'javascript');
edge('runCjs', 'exports.work', 'lib/common.cjs');
edge('exports.work', 'leaf', 'lib/common.cjs');
edge('runCjs', 'direct', 'lib/common.cjs');
edge('direct', 'leaf', 'lib/common.cjs');
assert.equal(edge('constructLegacy', 'Legacy').kind, 'construct');
assert.ok(!outgoing('builtin').length);
assert.ok(!calls.unresolved.some(site => site.caller === caller('builtin')?.id));

for (const [name, pattern] of [
  ['execute', /callback target/],
  ['indirect', /runtime expression/],
  ['dynamically', /property key/],
  ['missingCall', /alias/],
  ['typeOnlyMember', /alias/],
  ['dynamicImport', /Dynamic module loading/],
  ['invalid', /TS2769/],
  ['changed', /reassigned/],
  ['changedMember', /computed write/],
  ['decoratedMethod', /decorator/],
  ['invalidConstruct', /cannot be constructed/],
  ['shadowed', /callback target/]
] as const) {
  assert.equal(outgoing(name).length, 0, name + ' should have no confirmed calls');
  assert.ok(calls.unresolved.some(site => site.caller === caller(name)?.id && pattern.test(site.reason)), name);
}
assert.ok(calls.unresolved.some(site => site.caller === caller('Child.own')?.id && site.status === 'ambiguous'));
const dispatch = calls.unresolved.find(site => site.caller === caller('dispatch')?.id);
assert.equal(dispatch?.status, 'ambiguous');
assert.deepEqual(dispatch?.candidates?.map(id => byId.get(id)!.qualifiedName).sort(), ['Base.work', 'Override.work']);
assert.equal(outgoing('dispatch').length, 0);
assert.equal(outgoing('broad').length, 0);
assert.ok(calls.unresolved.some(site => site.caller === caller('replacingConstructor')?.id && site.status === 'ambiguous'));
assert.ok(!outgoing('replacingConstructor').some(item => byId.get(item.callee)?.name === 'work'));

function textAt(range: SourceRange): string {
  const lines = fs.readFileSync(path.join(fixture, range.file), 'utf8').split(/\r?\n/);
  assert.equal(range.startLine, range.endLine);
  return lines[range.startLine].slice(range.startColumn, range.endColumn);
}
assert.deepEqual(overload.sites.map(site => textAt(site.at)), ['overloaded(1)', "overloaded('x')"]);
assert.deepEqual(JSON.parse(JSON.stringify(calls)), calls);
assert.deepEqual(analyzeDependencyGraph(buildDependencyGraph(fixture)).functionGraph, calls);
assert.deepEqual(analyzeDependencyGraph(JSON.parse(JSON.stringify(buildDependencyGraph(fixture))), { rootDir: fixture }).functionGraph, calls);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-function-test-'));
try {
  fs.writeFileSync(path.join(temp, 'jsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'CommonJS', paths: { '@dep': ['./dep.js'] }, types: [] }
  }));
  fs.writeFileSync(path.join(temp, 'dep.js'), 'export function work() { return 1; }\n');
  fs.writeFileSync(path.join(temp, 'unicode.js'), [
    "import { work as café } from '@dep';",
    "export function 測試() { const s = '🧪'; café(); café(); }",
    ''
  ].join('\r\n'));
  const output = analyzeDependencyGraph(buildDependencyGraph(temp));
  const clean = output.functionGraph;
  assert.equal(clean.coverage, 'complete');
  assert.equal(clean.edges.length, 1);
  assert.deepEqual(clean.edges[0].sites.map(site => site.at), [
    { file: 'unicode.js', startLine: 1, startColumn: 39, endLine: 1, endColumn: 45 },
    { file: 'unicode.js', startLine: 1, startColumn: 47, endLine: 1, endColumn: 53 }
  ]);
  assert.ok(!JSON.stringify(output).includes(path.basename(temp)));
  assert.ok(!JSON.stringify(buildDependencyGraph(temp)).includes('_project'));

  fs.mkdirSync(path.join(temp, 'node_modules', 'external-lib'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'node_modules', 'external-lib', 'index.d.ts'), 'export function external(): number;');
  fs.writeFileSync(path.join(temp, 'external.ts'), [
    "import { external } from 'external-lib';",
    'export function local() { return external(); }'
  ].join('\n'));
  const withExternal = analyzeDependencyGraph(buildDependencyGraph(temp)).functionGraph;
  assert.equal(withExternal.coverage, 'complete');
  assert.ok(withExternal.nodes.every(node => node.name !== 'external'));
  assert.ok(withExternal.unresolved.every(site => site.at.file !== 'external.ts'));

  fs.writeFileSync(path.join(temp, 'jsconfig.json'), '{"compilerOptions":{"module":"bad"}');
  fs.writeFileSync(path.join(temp, 'malformed.ts'), 'export function malformed() { broken( \n');
  const partial = analyzeDependencyGraph(buildDependencyGraph(temp)).functionGraph;
  assert.equal(partial.coverage, 'partial');
  assert.ok(partial.diagnostics.some(item => item.code === 1005 && item.at?.file === 'jsconfig.json'));
  assert.ok(partial.diagnostics.some(item => item.code === 1005 && item.at?.file === 'malformed.ts'));
  assert.ok(partial.unresolved.some(item => item.at.file === 'malformed.ts'));
  assert.ok(!JSON.stringify(partial).includes(path.basename(temp)));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('Function-call graph fixtures passed.');

