import type { CallableNode, FunctionGraph, GraphData, SourceRange, SymbolUsageItem } from './types';

export interface ViewNode {
  id: string;
  label: string;
  detail: string;
  file: string;
  context?: string;
  callable?: CallableNode;
  cycle?: boolean;
}

export interface ViewEdge {
  id: string;
  source: string;
  target: string;
  cycle?: boolean;
  symbols?: SymbolUsageItem[];
  call?: FunctionGraph['edges'][number];
}

export const EDGE_LIMIT = 260;
export const NODE_LIMIT = 90;
export const edgeKey = (from: string, to: string) => JSON.stringify([from, to]);
export const basename = (file: string) => file.split('/').at(-1) || file;

export function location(range?: SourceRange) {
  if (!range) return 'Location unavailable';
  const start = (range.startLine + 1) + ':' + (range.startColumn + 1);
  const end = (range.endLine + 1) + ':' + (range.endColumn + 1);
  return range.file + ':' + start + '–' + end;
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const group = map.get(key);
  if (group) group.push(value);
  else map.set(key, [value]);
}

function index(nodes: ViewNode[], edges: ViewEdge[]) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const byEdge = new Map(edges.map(edge => [edge.id, edge]));
  const incoming = new Map<string, ViewEdge[]>();
  const outgoing = new Map<string, ViewEdge[]>();
  for (const edge of byEdge.values()) {
    append(incoming, edge.target, edge);
    append(outgoing, edge.source, edge);
  }
  return { nodes, edges: [...byEdge.values()], byId, byEdge, incoming, outgoing };
}

export type GraphIndex = ReturnType<typeof index>;

export function indexGraphs(data: GraphData) {
  const cycles = new Set(data.analysis.cycles.flat());
  const cycleEdges = new Set(data.analysis.cycles.flatMap(cycle =>
    cycle.map((id, i) => edgeKey(id, cycle[(i + 1) % cycle.length]))));
  const symbols = new Map<string, SymbolUsageItem[]>();
  for (const item of data.symbolUsage) append(symbols, edgeKey(item.usedInFile, item.fromFile), item);
  const files = index(data.nodes.map(node => ({
    id: node.id, label: basename(node.id), detail: node.id, file: node.id, cycle: cycles.has(node.id),
  })), data.edges.map(edge => {
    const id = edgeKey(edge.from, edge.to);
    return { id, source: edge.from, target: edge.to, cycle: cycleEdges.has(id), symbols: symbols.get(id) || [] };
  }));

  const functionsByFile = new Map<string, string[]>();
  const fnNodes = (data.functionGraph?.nodes ?? []).map(callable => {
    append(functionsByFile, callable.file, callable.id);
    const line = callable.declaration && ':' + (callable.declaration.startLine + 1);
    return {
      id: callable.id, label: callable.qualifiedName + '()', file: callable.file,
      detail: callable.file + (line || ''), callable,
    };
  });
  const functionLabels = new Map<string, Set<string>>();
  for (const node of fnNodes) {
    const key = edgeKey(node.label, basename(node.file));
    const files = functionLabels.get(key) ?? new Set<string>();
    files.add(node.file);
    functionLabels.set(key, files);
  }
  const functionNodes = fnNodes.map(node => {
    const shared = (functionLabels.get(edgeKey(node.label, basename(node.file)))?.size ?? 0) > 1;
    return { ...node, context: shared ? node.file : basename(node.file) };
  });
  const functions = index(functionNodes, (data.functionGraph?.edges ?? []).map(call => ({
    id: call.id, source: call.caller, target: call.callee, call,
  })));
  const callsByFilePair = new Map<string, ViewEdge[]>();
  for (const edge of functions.edges) {
    const source = functions.byId.get(edge.source)?.file;
    const target = functions.byId.get(edge.target)?.file;
    if (source && target) append(callsByFilePair, edgeKey(source, target), edge);
  }
  const unresolvedByCaller = new Map<string, FunctionGraph['unresolved']>();
  for (const call of data.functionGraph?.unresolved ?? []) {
    if (call.caller) append(unresolvedByCaller, call.caller, call);
  }
  const moduleCallsByFile = new Map<string, FunctionGraph['moduleCalls']>();
  for (const call of data.functionGraph?.moduleCalls ?? []) append(moduleCallsByFile, call.at.file, call);
  return { files, functions, functionsByFile, unresolvedByCaller, callsByFilePair, moduleCallsByFile };
}

export function incident(index: GraphIndex, id: string) {
  return [...(index.outgoing.get(id) ?? []), ...(index.incoming.get(id) ?? [])];
}

/** Grow from roots in both directions. Priority IDs preserve an explicit selection under the cap. */
export function projectGraph(
  index: GraphIndex, roots: readonly string[] | undefined, depth: number,
  priority: readonly string[] = [], allowedEdges?: ReadonlySet<string>, selectedEdge?: string,
  reserveForNeighbors = false
) {
  const ids = new Set<string>();
  const traversed = new Set<string>();
  let limited = false;
  function add(id: string) {
    if (ids.has(id) || !index.byId.has(id)) return false;
    if (ids.size === NODE_LIMIT) {
      limited = true;
      return false;
    }
    ids.add(id);
    return true;
  }
  priority.forEach(add);
  let frontier: string[] = [];
  for (const id of roots ?? index.byId.keys()) {
    // Large files leave room for callers and callees from other files.
    if (reserveForNeighbors && !priority.includes(id) && frontier.length >= Math.floor(NODE_LIMIT / 2)) {
      limited = true;
      break;
    }
    if (add(id) || ids.has(id)) frontier.push(id);
    else if (limited) break;
  }
  let canExpand = false;
  for (let level = 0; frontier.length; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (traversed.has(id)) continue;
      traversed.add(id);
      for (const edge of incident(index, id)) {
        if (allowedEdges && !allowedEdges.has(edge.id)) continue;
        const other = edge.source === id ? edge.target : edge.source;
        if (ids.has(other)) continue;
        if (level >= depth) canExpand = true;
        else if (add(other)) next.push(other);
      }
    }
    frontier = next;
  }

  const edges = new Map<string, ViewEdge>();
  function include(edge: ViewEdge) {
    if ((allowedEdges && !allowedEdges.has(edge.id)) || !ids.has(edge.source) || !ids.has(edge.target) || edges.has(edge.id)) return;
    if (edges.size === EDGE_LIMIT) limited = true;
    else edges.set(edge.id, edge);
  }
  const inspected = selectedEdge && index.byEdge.get(selectedEdge);
  if (inspected) include(inspected);
  for (const id of priority) incident(index, id).forEach(include);
  for (const id of ids) index.outgoing.get(id)?.forEach(include);
  return { nodes: [...ids].map(id => index.byId.get(id)!), edges: [...edges.values()], limited, canExpand: canExpand && ids.size < NODE_LIMIT };
}
