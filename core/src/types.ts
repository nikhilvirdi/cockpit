export interface GraphNode {
  id: string;
  path: string;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphEngineOptions {
  tsConfigPath?: string;
}

export interface AnalysisResult {
  cycles: string[][];
}

export interface SymbolUsageItem {
  importedSymbol: string;
  fromFile: string;
  usedInFile: string;
  usedInScope: string;
  line: number;
  typeOnly: boolean;
  note?: string;
}

export interface AnalyzedGraph extends DependencyGraph {
  analysis: AnalysisResult;
  symbolUsage: SymbolUsageItem[];
}

export interface AnalysisOptions {
  rootDir?: string;
  maxCycles?: number;
}

