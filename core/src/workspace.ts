import * as fs from 'fs';
import * as path from 'path';
import { analyzeDependencyGraph, detectCycles } from './analysis';
import { buildDependencyGraph } from './engine';
import { toPosixPath, walkDirectory } from './scanner';
import { isAnalysisInput, languageOf } from './sourceKinds';
import { analyzeScip, indexerNames, readIndex, unavailable } from './scip';
import type { IndexedProject, IndexProvider, LanguageResult } from './scip';
import type { AnalyzedGraph, FunctionGraph, GraphEdge, GraphNode, IndexedLanguage, LanguageCoverage } from './types';

const markers: Record<IndexedLanguage, string[]> = {
  python: ['pyproject.toml', 'pyrightconfig.json', 'setup.cfg', 'requirements.txt', 'setup.py'],
  go: ['go.mod', 'go.work'],
  java: ['pom.xml', 'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'],
  c: ['compile_commands.json', 'cmakelists.txt'],
  cpp: ['compile_commands.json', 'cmakelists.txt']
};

function discover(root: string) {
  const paths = walkDirectory(root, isAnalysisInput).sort();
  const metadata = new Map<string, Map<string, string>>();
  const groups = new Map<string, IndexedProject>();
  for (const file of paths) {
    const directory = path.dirname(file);
    const name = path.basename(file).toLowerCase();
    let entries = metadata.get(directory);
    if (!entries) metadata.set(directory, entries = new Map());
    entries.set(name, file);
  }
  for (const file of paths) {
    const language = languageOf(file);
    if (!language || language === 'javascript' || language === 'typescript') continue;
    let candidate = path.dirname(file);
    let projectRoot = root;
    for (;;) {
      const entries = metadata.get(candidate);
      if (entries?.has('index.scip') || entries?.has(indexerNames[language] + '.scip')
        || markers[language].some(name => entries?.has(name))) {
        projectRoot = candidate;
        break;
      }
      if (candidate === root) break;
      candidate = path.dirname(candidate);
    }
    const key = JSON.stringify([indexerNames[language], projectRoot]);
    let group = groups.get(key);
    if (!group) groups.set(key, group = { root: projectRoot, language, files: [] });
    group.files.push({ id: toPosixPath(path.relative(root, file)), path: file, language });
  }
  return { groups: [...groups.values()], metadata };
}

function missingIndex(project: IndexedProject, metadata: Map<string, string> | undefined): string {
  const name = indexerNames[project.language];
  if (project.language === 'go' && !markers.go.some(name => metadata?.has(name))) {
    return 'Go module metadata is missing. Supply a project index or configure a Go module or workspace.';
  }
  if ((project.language === 'c' || project.language === 'cpp') && !metadata?.has('compile_commands.json')) {
    return 'No compilation database or SCIP index is available. Generate an index with a valid compile_commands.json in an isolated toolchain.';
  }
  if (project.language === 'java' && !markers.java.some(name => metadata?.has(name))) {
    return 'No Java build metadata or SCIP index is available. Supply a scip-java index with the correct classpath.';
  }
  return 'No ' + name + ' index is available. Supply index.scip or configure an isolated indexer for this language.';
}

function invalidCompilationDatabase(file: string): boolean {
  try {
    if (fs.statSync(file).size > 1024 * 1024) return true;
    const entries = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return !Array.isArray(entries) || !entries.length || entries.some(entry =>
      !entry || typeof entry.file !== 'string' || !entry.file || typeof entry.directory !== 'string'
      || !entry.directory || !(typeof entry.command === 'string' && entry.command
        || Array.isArray(entry.arguments) && entry.arguments.length && entry.arguments.every((arg: unknown) => typeof arg === 'string')));
  } catch {
    return true;
  }
}

function merge(base: AnalyzedGraph, results: LanguageResult[], failedJs: LanguageCoverage[], signal?: AbortSignal): AnalyzedGraph {
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
      const previous = edgeByPair.get(key);
      if (!previous) edgeByPair.set(key, edge);
      else {
        edgeByPair.set(key, { ...previous, evidence: [...new Map([...(previous.evidence ?? []), ...(edge.evidence ?? [])]
          .map(site => [JSON.stringify(site), site])).values()] });
      }
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

/** Preserves the existing JS/TS API while sharing one workspace result with the other adapters. */
export async function analyzeWorkspace(root: string, options: { provideIndex?: IndexProvider; signal?: AbortSignal } = {}): Promise<AnalyzedGraph> {
  const workspace = path.resolve(root);
  const { groups, metadata } = discover(workspace);
  options.signal?.throwIfAborted();
  let base: AnalyzedGraph;
  const failedJs: LanguageCoverage[] = [];
  try {
    base = analyzeDependencyGraph(buildDependencyGraph(workspace), { rootDir: workspace });
  } catch (error) {
    if (!groups.length) throw error;
    const nodes: GraphNode[] = [];
    for (const entries of metadata.values()) {
      for (const file of entries.values()) {
        const language = languageOf(file);
        if (language !== 'javascript' && language !== 'typescript') continue;
        const id = toPosixPath(path.relative(workspace, file));
        nodes.push({ id, path: id, language });
        if (failedJs.some(item => item.language === language)) continue;
        failedJs.push({ language, root: '.', analyzer: 'ts-morph', status: 'unavailable',
          diagnostics: ['The TypeScript compiler could not analyze this workspace.'] });
      }
    }
    if (!nodes.length) throw error;
    base = { nodes, edges: [], analysis: { cycles: [] }, symbolUsage: [],
      functionGraph: { nodes: [], edges: [], moduleCalls: [], unresolved: [], diagnostics: [], coverage: 'unavailable' } };
  }

  const results: LanguageResult[] = [];
  const decoded = new Map<string, ReturnType<typeof readIndex>>();
  for (const project of groups) {
    options.signal?.throwIfAborted();
    const entries = metadata.get(project.root);
    let index = entries?.get(indexerNames[project.language] + '.scip') ?? entries?.get('index.scip');
    const database = entries?.get('compile_commands.json');
    if (!index && (project.language === 'c' || project.language === 'cpp')) {
      if (!database || invalidCompilationDatabase(database)) {
        results.push(unavailable(project, workspace, database
          ? 'The compilation database is invalid or exceeds the size limit.' : missingIndex(project, entries)));
        continue;
      }
    }
    if (!index && options.provideIndex) {
      try {
        index = await options.provideIndex(project, options.signal);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const message = error instanceof Error && !('code' in error) && !error.message.includes(project.root)
          ? error.message : 'The isolated indexer failed.';
        results.push(unavailable(project, workspace, message));
        continue;
      }
    }
    results.push(await analyzeScip(project, {
      workspace, index, decoded, signal: options.signal, missing: missingIndex(project, entries)
    }));
  }
  return merge(base, results, failedJs, options.signal);
}

