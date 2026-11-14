import type { AnalyzedGraph } from '../../core/src/types';

// Shared types for Cockpit graph data and UI state

export interface GraphNode {
  id: string;
  path: string;
}

export interface GraphEdge {
  from: string;
  to: string;
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

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  analysis: AnalysisResult;
  symbolUsage: SymbolUsageItem[];
  functionGraph?: AnalyzedGraph['functionGraph'];
}

export interface SelectedNodeInfo {
  id: string;
  label: string;
  fullPath: string;
  isCycle: boolean;
  incoming: string[];
  outgoing: string[];
}

export interface SelectedEdgeInfo {
  id: string;
  source: string;
  target: string;
  isCycle: boolean;
  hasTracedSymbols: boolean;
  symbolUsages: SymbolUsageItem[];
}

export type InputMode = 'github' | 'folder';
