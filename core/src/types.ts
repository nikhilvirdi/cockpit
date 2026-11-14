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

/** Zero-based UTF-16 line/column pairs, with an exclusive end. */
export interface SourceRange {
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface CallableNode {
  id: string;
  name: string;
  qualifiedName: string;
  kind: 'function' | 'arrow' | 'method' | 'static-method' | 'constructor' | 'getter' | 'setter';
  language: 'javascript' | 'typescript';
  file: string;
  declaration: SourceRange;
}

export interface CallEvidence {
  at: SourceRange;
  target: SourceRange;
  /** The selected overload, when it differs from the implementation. */
  signature?: SourceRange;
}

export interface FunctionCallEdge {
  id: string;
  caller: string;
  callee: string;
  kind: 'call' | 'construct';
  sites: CallEvidence[];
}

export interface UnresolvedCall {
  at: SourceRange;
  caller?: string;
  status: 'unresolved' | 'ambiguous';
  reason: string;
  candidates?: string[];
}

export interface FunctionGraph {
  nodes: CallableNode[];
  edges: FunctionCallEdge[];
  moduleCalls: Array<CallEvidence & { callee: string; kind: FunctionCallEdge['kind'] }>;
  unresolved: UnresolvedCall[];
  coverage: 'complete' | 'partial' | 'unavailable';
  diagnostics: Array<{ code: number; reason: string; at?: SourceRange }>;
}

export interface AnalyzedGraph extends DependencyGraph {
  analysis: AnalysisResult;
  symbolUsage: SymbolUsageItem[];
  functionGraph: FunctionGraph;
}

export interface AnalysisOptions {
  rootDir?: string;
  maxCycles?: number;
}

