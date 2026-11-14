export { buildDependencyGraph } from './engine';
export { analyzeDependencyGraph, detectCycles } from './analysis';
export { analyzeWorkspace } from './workspace';
export type { NativeLanguage, NativeProvider, NativeOutput } from './native';
export { traceSymbolUsages, getEnclosingScopeName, isTypeOnlyReference } from './symbolUsage';
export { resolveImportTarget, tryCandidatePath } from './resolver';
export { loadTsConfig, loadTsConfigForFile, TsConfigInfo } from './tsconfig';
export { walkDirectory, isSourceFile, toPosixPath } from './scanner';
export {
  DependencyGraph,
  GraphEdge,
  GraphNode,
  GraphEngineOptions,
  AnalyzedGraph,
  AnalysisResult,
  AnalysisOptions,
  SymbolUsageItem,
  SourceRange,
  CallableNode,
  CallEvidence,
  FunctionCallEdge,
  UnresolvedCall,
  FunctionGraph,
  Language,
  LanguageCoverage
} from './types';
