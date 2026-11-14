import * as fs from 'fs';
import * as path from 'path';
import { Project } from 'ts-morph';
import {
  DependencyGraph,
  AnalyzedGraph,
  AnalysisOptions,
  SymbolUsageItem
} from './types';
import { traceSymbolUsages } from './symbolUsage';

/**
 * Detects all elementary cycles in the graph using Johnson's algorithm with Tarjan's SCC.
 */
export function detectCycles(
  nodes: { id: string }[],
  edges: { from: string; to: string }[],
  maxCycles: number = 500
): string[][] {
  const nodeIds = nodes.map(n => n.id).sort();
  const nodeIndex = new Map<string, number>();
  nodeIds.forEach((id, idx) => nodeIndex.set(id, idx));

  // Build adjacency list
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) {
    adj.set(id, []);
  }
  for (const edge of edges) {
    if (adj.has(edge.from) && adj.has(edge.to)) {
      adj.get(edge.from)!.push(edge.to);
    }
  }

  // Tarjan's Strongly Connected Components on a subset of nodes
  function getSCCs(subgraphSet: Set<string>): string[][] {
    let index = 0;
    const indices = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: string[][] = [];

    function strongConnect(v: string) {
      indices.set(v, index);
      lowlink.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);

      const neighbors = adj.get(v) || [];
      for (const w of neighbors) {
        if (!subgraphSet.has(w)) continue;
        if (!indices.has(w)) {
          strongConnect(w);
          lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
        } else if (onStack.has(w)) {
          lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
        }
      }

      if (lowlink.get(v) === indices.get(v)) {
        const scc: string[] = [];
        while (true) {
          const w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
          if (w === v) break;
        }
        sccs.push(scc);
      }
    }

    for (const v of subgraphSet) {
      if (!indices.has(v)) {
        strongConnect(v);
      }
    }

    return sccs;
  }

  const cycles: string[][] = [];
  let sIdx = 0;

  while (sIdx < nodeIds.length && cycles.length < maxCycles) {
    const subNodes = new Set<string>();
    for (let i = sIdx; i < nodeIds.length; i++) {
      subNodes.add(nodeIds[i]);
    }

    const sccs = getSCCs(subNodes);

    let minScc: string[] | null = null;
    let minStartIdx = Infinity;
    let minStartNode: string | null = null;

    for (const scc of sccs) {
      const isNonTrivial =
        scc.length > 1 || (scc.length === 1 && (adj.get(scc[0]) || []).includes(scc[0]));
      if (isNonTrivial) {
        for (const node of scc) {
          const idx = nodeIndex.get(node)!;
          if (idx < minStartIdx) {
            minStartIdx = idx;
            minStartNode = node;
            minScc = scc;
          }
        }
      }
    }

    if (!minScc || minStartNode === null) {
      break;
    }

    const s = minStartNode;
    sIdx = minStartIdx;

    const sccSet = new Set(minScc);
    const blocked = new Set<string>();
    const B = new Map<string, Set<string>>();
    const stack: string[] = [];

    function unblock(u: string) {
      blocked.delete(u);
      const bSet = B.get(u);
      if (bSet) {
        for (const w of bSet) {
          if (blocked.has(w)) {
            unblock(w);
          }
        }
        bSet.clear();
      }
    }

    function circuit(v: string): boolean {
      if (cycles.length >= maxCycles) return false;
      let f = false;
      stack.push(v);
      blocked.add(v);

      const neighbors = adj.get(v) || [];
      for (const w of neighbors) {
        if (!sccSet.has(w)) continue;
        if (w === s) {
          cycles.push([...stack]);
          f = true;
          if (cycles.length >= maxCycles) break;
        } else if (!blocked.has(w)) {
          if (circuit(w)) {
            f = true;
          }
        }
      }

      if (f) {
        unblock(v);
      } else {
        for (const w of neighbors) {
          if (!sccSet.has(w)) continue;
          let bSet = B.get(w);
          if (!bSet) {
            bSet = new Set();
            B.set(w, bSet);
          }
          bSet.add(v);
        }
      }

      stack.pop();
      return f;
    }

    circuit(s);
    sIdx++;
  }

  // Sort cycles by length, then alphabetically for deterministic output
  cycles.sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    return a.join('>').localeCompare(b.join('>'));
  });

  return cycles;
}

/**
 * Adds cycle and symbol-reference evidence to an import dependency graph.
 *
 * @param graph Input dependency graph with { nodes, edges }
 * @param options Optional configuration including rootDir and maxCycles
 * @returns Graph with cycle analysis and symbol usages
 */
export function analyzeDependencyGraph(
  graph: DependencyGraph,
  options?: AnalysisOptions
): AnalyzedGraph {
  const { nodes, edges } = graph;

  const rootDir = options?.rootDir ? path.resolve(options.rootDir) : process.cwd();
  let project: Project = (graph as any)._project;

  if (!project) {
    project = new Project({
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true }
    });
    for (const node of nodes) {
      if (fs.existsSync(node.path)) {
        project.addSourceFileAtPath(node.path);
      }
    }
  }

  const symbolUsage: SymbolUsageItem[] = traceSymbolUsages(project, nodes, edges, rootDir);

  return {
    nodes,
    edges,
    analysis: { cycles: detectCycles(nodes, edges, options?.maxCycles) },
    symbolUsage
  };
}
