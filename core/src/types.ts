export type Language = 'javascript' | 'typescript' | 'python' | 'go' | 'java' | 'c' | 'cpp';
export type IndexedLanguage = Exclude<Language, 'javascript' | 'typescript'>;

export interface GraphNode {
  id: string;
  path: string;
  kind?: 'package';
  name?: string;
  language?: Language;
}

export type DependencyKind = 'import' | 'include' | 'reference';

export interface GraphEdge {
  from: string;
  to: string;
  kind?: DependencyKind;
  evidence?: SourceRange[];
  /** Additional evidence categories for the same directed dependency. */
  additionalEvidence?: Partial<Record<DependencyKind, SourceRange[]>>;
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
  language: Language;
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
  languageCoverage?: LanguageCoverage[];
}

export interface LanguageCoverage {
  language: Language;
  root: string;
  analyzer: string;
  status: FunctionGraph['coverage'];
  diagnostics: string[];
}

export interface AnalysisOptions {
  rootDir?: string;
  maxCycles?: number;
}

