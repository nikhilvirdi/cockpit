import * as path from 'path';
import { analyzeDependencyGraph, detectCycles } from './analysis';
import { buildDependencyGraph } from './engine';
import { toPosixPath, walkDirectory } from './scanner';
import { languageOf } from './sourceKinds';
import { emptyNative, normalizeNative } from './native';
import type { NativeGraph, NativeLanguage, NativeProvider } from './native';
import type { AnalyzedGraph, FunctionGraph, GraphEdge, GraphNode, LanguageCoverage } from './types';

function merge(base: AnalyzedGraph, results: NativeGraph[], failedJs: LanguageCoverage[], signal?: AbortSignal): AnalyzedGraph {
  if (!results.length && !failedJs.length) return base;
  signal?.throwIfAborted();
  const nodeById = new Map<string, GraphNode>(base.nodes.map(node => [node.id, node]));
  const edgeByPair = new Map<string, GraphEdge>(base.edges.map(edge => [JSON.stringify([edge.from, edge.to]), edge]));
  const functions: FunctionGraph = {
    ...base.functionGraph, nodes: [...base.functionGraph.nodes], edges: [...base.functionGraph.edges],
    moduleCalls: [...base.functionGraph.moduleCalls], unresolved: [...base.functionGraph.unresolved],
    diagnostics: [...base.functionGraph.diagnostics]
  };
  const coverage: LanguageCoverage[] = [...failedJs];
  const jsLanguages = new Set(base.nodes.filter(node => !node.language).map(node => languageOf(node.id)));
  for (const language of jsLanguages) {
    if (language !== 'javascript' && language !== 'typescript') continue;
    coverage.push({ language, root: '.', analyzer: 'ts-morph', status: base.functionGraph.coverage, diagnostics: [] });
  }
  for (const result of results) {
    coverage.push(...result.coverage);
    for (const node of result.nodes) {
      nodeById.set(node.id, { ...node, path: node.kind === 'package' ? node.path : node.id });
    }
    for (const edge of result.edges) {
      const key = JSON.stringify([edge.from, edge.to]);
      // Each adapter owns its consumer files and has already aggregated their evidence.
      edgeByPair.set(key, edge);
    }
    for (const node of result.functions.nodes) functions.nodes.push(node);
    for (const edge of result.functions.edges) functions.edges.push(edge);
    for (const call of result.functions.moduleCalls) functions.moduleCalls.push(call);
    for (const unresolved of result.functions.unresolved) functions.unresolved.push(unresolved);
  }
  const nodes = [...nodeById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...edgeByPair.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  functions.nodes.sort((a, b) => a.file.localeCompare(b.file) || a.declaration.startLine - b.declaration.startLine
    || a.declaration.startColumn - b.declaration.startColumn || a.id.localeCompare(b.id));
  functions.edges.sort((a, b) => a.id.localeCompare(b.id));
  functions.coverage = coverage.every(item => item.status === 'unavailable') ? 'unavailable'
    : coverage.every(item => item.status === 'complete') ? 'complete' : 'partial';
  return { nodes, edges, symbolUsage: base.symbolUsage, analysis: { cycles: detectCycles(nodes, edges) },
    functionGraph: functions, languageCoverage: coverage.sort((a, b) =>
      a.language.localeCompare(b.language) || a.root.localeCompare(b.root)) };
}
export async function analyzeWorkspace(root: string, options: { analyzeNative?: NativeProvider; signal?: AbortSignal } = {}): Promise<AnalyzedGraph> {
  const workspace = path.resolve(root);
  options.signal?.throwIfAborted();
  const paths = walkDirectory(workspace).sort();
  const groups = new Map<NativeLanguage, GraphNode[]>();
  for (const file of paths) {
    const mode = languageOf(file);
    if (!mode || mode === 'typescript' || mode === 'javascript') continue;
    const language = mode === 'cpp' ? 'c' : mode;
    const id = toPosixPath(path.relative(workspace, file));
    const group = groups.get(language) ?? [];
    group.push({ id, path: id, language: /\.h$/i.test(id) ? undefined : mode });
    groups.set(language, group);
  }
  let base: AnalyzedGraph;
  const failedJs: LanguageCoverage[] = [];
  try {
    base = analyzeDependencyGraph(buildDependencyGraph(workspace), { rootDir: workspace });
  } catch (error) {
    if (!groups.size) throw error;
    const nodes: GraphNode[] = [];
    for (const file of paths) {
      const language = languageOf(file);
      if (language !== 'javascript' && language !== 'typescript') continue;
      const id = toPosixPath(path.relative(workspace, file));
      nodes.push({ id, path: id, language });
      if (failedJs.some(item => item.language === language)) continue;
      failedJs.push({ language, root: '.', analyzer: 'ts-morph', status: 'unavailable',
        diagnostics: ['The TypeScript compiler could not analyze this workspace.'] });
    }
    if (!nodes.length) throw error;
    base = { nodes, edges: [], analysis: { cycles: [] }, symbolUsage: [],
      functionGraph: { nodes: [], edges: [], moduleCalls: [], unresolved: [], diagnostics: [], coverage: 'unavailable' } };
  }


  const results: NativeGraph[] = [];
  for (const [language, files] of groups) {
    options.signal?.throwIfAborted();
    let output;
    try {
      output = await options.analyzeNative?.(workspace, language, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const message = error instanceof Error && !('code' in error) && !error.message.includes(workspace)
        ? error.message : 'The isolated analyzer could not run.';
      results.push(emptyNative(files, language, message));
      continue;
    }
    if (!output) {
      results.push(emptyNative(files, language, 'Configure the Cockpit native analyzer image to analyze this language.'));
      continue;
    }
    try {
      results.push(normalizeNative(workspace, language, files, output));
    } catch {
      results.push(emptyNative(files, language, 'The isolated analyzer returned an invalid or incompatible result.'));
    }
  }
  return merge(base, results, failedJs, options.signal);
}
