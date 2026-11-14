import type { CallableNode, FunctionGraph, GraphData, Language, LanguageCoverage, PresentedFunctionGraph, SourceRange } from './types';

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const number = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const isLanguage = (value: unknown): value is Language =>
  ['javascript', 'typescript', 'python', 'go', 'java', 'c', 'cpp'].some(language => language === value);

function range(value: unknown): value is SourceRange {
  return object(value) && string(value.file) && number(value.startLine) && number(value.startColumn)
    && number(value.endLine) && number(value.endColumn)
    && (value.endLine > value.startLine || value.endLine === value.startLine && value.endColumn >= value.startColumn);
}

function readFunctionGraph(value: unknown): PresentedFunctionGraph | undefined {
  if (!object(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)
    || (value.coverage !== 'complete' && value.coverage !== 'partial' && value.coverage !== 'unavailable')) return;
  let incomplete = false;
  const nodes = new Map<string, CallableNode>();
  for (const node of value.nodes) {
    if (!object(node) || !string(node.id) || !string(node.name) || !string(node.file) || nodes.has(node.id)) continue;
    if (!range(node.declaration)) incomplete = true;
    nodes.set(node.id, {
      id: node.id, name: node.name, file: node.file, kind: string(node.kind) ? node.kind : '',
      language: isLanguage(node.language) ? node.language : undefined,
      qualifiedName: string(node.qualifiedName) ? node.qualifiedName : node.name,
      declaration: range(node.declaration) ? node.declaration : undefined,
    });
  }
  const edges = new Map<string, FunctionGraph['edges'][number]>();
  for (const edge of value.edges) {
    if (!object(edge) || !string(edge.id) || !string(edge.caller) || !nodes.has(edge.caller)
      || !string(edge.callee) || !nodes.has(edge.callee) || edges.has(edge.id)
      || (edge.kind !== 'call' && edge.kind !== 'construct')) continue;
    const sites = array(edge.sites).flatMap(site => object(site) && range(site.at) && range(site.target)
      ? [{ at: site.at, target: site.target, signature: range(site.signature) ? site.signature : undefined }] : []);
    if (!sites.length || sites.length !== array(edge.sites).length) incomplete = true;
    edges.set(edge.id, { id: edge.id, caller: edge.caller, callee: edge.callee, kind: edge.kind, sites });
  }
  const unresolved = array(value.unresolved).flatMap<FunctionGraph['unresolved'][number]>(item => object(item) && range(item.at) && string(item.reason)
    && (item.status === 'ambiguous' || item.status === 'unresolved')
    ? [{ at: item.at, reason: item.reason, status: item.status, caller: string(item.caller) ? item.caller : undefined,
      candidates: array(item.candidates).filter(string) }] : []);
  const diagnostics = array(value.diagnostics).flatMap(item => object(item) && number(item.code) && string(item.reason)
    ? [{ code: item.code, reason: item.reason, at: range(item.at) ? item.at : undefined }] : []);
  const moduleCalls = array(value.moduleCalls).flatMap<FunctionGraph['moduleCalls'][number]>(item => object(item) && range(item.at) && range(item.target)
    && string(item.callee) && nodes.has(item.callee) && (item.kind === 'call' || item.kind === 'construct')
    ? [{ at: item.at, target: item.target, signature: range(item.signature) ? item.signature : undefined,
      callee: item.callee, kind: item.kind }] : []);
  incomplete ||= nodes.size !== value.nodes.length || edges.size !== value.edges.length
    || unresolved.length !== array(value.unresolved).length || diagnostics.length !== array(value.diagnostics).length
    || moduleCalls.length !== array(value.moduleCalls).length;
  return {
    nodes: [...nodes.values()], edges: [...edges.values()], unresolved, diagnostics, moduleCalls,
    coverage: value.coverage === 'unavailable' ? 'unavailable'
      : value.coverage === 'partial' || incomplete || unresolved.length || diagnostics.length ? 'partial' : 'complete',
  };
}

export function readGraph(value: unknown): GraphData {
  if (!object(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error('The server returned an invalid dependency graph.');
  }
  const nodes = new Map<string, GraphData['nodes'][number]>();
  for (const node of value.nodes) {
    if (!object(node) || !string(node.id)) throw new Error('The server returned an invalid file node.');
    nodes.set(node.id, {
      id: node.id, path: node.kind === 'package' && string(node.path) ? node.path : node.id,
      kind: node.kind === 'package' ? node.kind : undefined, name: string(node.name) ? node.name : undefined,
      language: isLanguage(node.language) ? node.language : undefined
    });
  }
  const edges = value.edges.flatMap(edge => object(edge) && string(edge.from) && nodes.has(edge.from)
    && string(edge.to) && nodes.has(edge.to) ? [{
      from: edge.from, to: edge.to,
      kind: edge.kind === 'include' || edge.kind === 'import' || edge.kind === 'reference' ? edge.kind : undefined,
      evidence: array(edge.evidence).filter(range)
    } as GraphData['edges'][number]] : []);
  const cycles = array(object(value.analysis) ? value.analysis.cycles : undefined)
    .filter((cycle): cycle is string[] => Array.isArray(cycle) && cycle.length > 0
      && cycle.every(id => string(id) && nodes.has(id)));
  const symbolUsage = array(value.symbolUsage).flatMap(item => object(item) && string(item.fromFile) && string(item.usedInFile)
    && string(item.importedSymbol) && string(item.usedInScope) && number(item.line) && item.line > 0
    ? [{ fromFile: item.fromFile, usedInFile: item.usedInFile, importedSymbol: item.importedSymbol,
      usedInScope: item.usedInScope, line: item.line, typeOnly: item.typeOnly === true,
      note: string(item.note) ? item.note : undefined }] : []);
  const languageCoverage = array(value.languageCoverage).flatMap<LanguageCoverage>(item => object(item)
    && isLanguage(item.language) && string(item.root) && string(item.analyzer)
    && (item.status === 'complete' || item.status === 'partial' || item.status === 'unavailable')
    ? [{ language: item.language, root: item.root, analyzer: item.analyzer, status: item.status,
      diagnostics: array(item.diagnostics).filter(string) }] : []);
  return { nodes: [...nodes.values()], edges, analysis: { cycles }, symbolUsage,
    functionGraph: readFunctionGraph(value.functionGraph), languageCoverage };
}

export async function analyze(response: Promise<Response>): Promise<GraphData> {
  const res = await response;
  const data: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    throw new Error(object(data) && string(data.error) ? data.error : 'Analysis failed (HTTP ' + res.status + ').');
  }
  return readGraph(data);
}
