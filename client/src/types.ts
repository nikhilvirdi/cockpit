import type { AnalyzedGraph } from '../../core/src/types';

export type { FunctionGraph, SourceRange, SymbolUsageItem } from '../../core/src/types';
/** The client can display partial evidence and callable kinds added by a newer analyzer. */
export type CallableNode = Omit<AnalyzedGraph['functionGraph']['nodes'][number], 'kind' | 'language' | 'declaration'> & {
  kind: string;
  declaration?: AnalyzedGraph['functionGraph']['nodes'][number]['declaration'];
};
export type PresentedFunctionGraph = Omit<AnalyzedGraph['functionGraph'], 'nodes'> & { nodes: CallableNode[] };
export type GraphData = Omit<AnalyzedGraph, 'functionGraph'> & { functionGraph?: PresentedFunctionGraph };
export type InputMode = 'github' | 'folder';
export type View = 'files' | 'functions';
export type Selection = { kind: 'node' | 'edge'; id: string } | null;
