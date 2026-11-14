import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CallableNode, DependencyKind, FunctionGraph, GraphEdge, GraphNode, IndexedLanguage, LanguageCoverage, SourceRange } from './types';

export type NativeLanguage = Exclude<IndexedLanguage, 'cpp'>;
export type NativeOutput = { bytes: Uint8Array; sourceHashes: ReadonlyMap<string, string> };
export type NativeProvider = (root: string, language: NativeLanguage, signal?: AbortSignal) => Promise<NativeOutput | undefined>;
export const nativeTools: Record<NativeLanguage, string> = {
  python: 'jedi 0.19.2', go: 'go/packages v0.52.0', java: 'javaparser 3.27.1', c: 'clang 19.1.7'
};

export interface NativeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  functions: FunctionGraph;
  coverage: LanguageCoverage[];
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const tuple = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const tables = ['files', 'packages', 'callables', 'dependencies', 'calls', 'diagnostics'] as const;
const fileKinds = new Set<DependencyKind>(['import', 'include', 'reference']);
const callableKinds = new Set<CallableNode['kind']>(['function', 'method', 'static-method', 'constructor']);

function rows(value: unknown): unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 200_000) throw new Error('Analyzer protocol row limit exceeded.');
  return value;
}

export function emptyNative(files: GraphNode[], language: NativeLanguage, message?: string): NativeGraph {
  const languages = new Set(files.flatMap(node => node.language ? [node.language] : []));
  if (!languages.size) languages.add(language);
  return { nodes: files, edges: [], functions: { nodes: [], edges: [], moduleCalls: [], unresolved: [], diagnostics: [],
    coverage: 'unavailable' }, coverage: [...languages].sort().map(name => ({
    language: name, root: '.', status: 'unavailable', analyzer: nativeTools[language], diagnostics: message ? [message] : []
  })) };
}

export function normalizeNative(root: string, language: NativeLanguage, files: GraphNode[], output: NativeOutput): NativeGraph {
  if (output.bytes.byteLength > 12 * 1024 * 1024) throw new Error('Analyzer result exceeds the byte limit.');
  const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output.bytes));
  if (!isObject(raw) || raw.version !== 1 || raw.tool !== nativeTools[language] || !Object.hasOwn(raw, 'files')) {
    throw new Error('Analyzer protocol version or tool version is unsupported.');
  }
  const input = Object.fromEntries(tables.map(key => [key, rows(raw[key])])) as Record<typeof tables[number], unknown[]>;
  const result = emptyNative(files, language);
  const nodes = new Map(files.map(node => [node.id, node]));
  const source = new Map<string, string[] | undefined>();
  let rejected = false;
  function lines(file: unknown) {
    if (typeof file !== 'string' || !nodes.has(file) || !output.sourceHashes.has(file)) return;
    if (!source.has(file)) {
      try {
        const target = path.join(root, file);
        const stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error();
        const bytes = fs.readFileSync(target);
        if (output.sourceHashes.get(file) === createHash('sha256').update(bytes).digest('hex')) {
          source.set(file, new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).split(/\r\n|\n|\r/));
        }
      } catch {
        // A deleted or invalid source document cannot support graph evidence.
      }
      if (!source.has(file)) source.set(file, undefined);
    }
    return source.get(file);
  }
  const verified = new Set<string>();
  for (const row of input.files) {
    const [file, mode] = tuple(row);
    if (typeof file !== 'string' || !lines(file) || !(mode === language || language === 'c' && mode === 'cpp')) {
      rejected = true;
      continue;
    }
    verified.add(file);
    nodes.set(file, { ...nodes.get(file)!, language: mode === 'cpp' ? 'cpp' : language });
  }
  function range(value: unknown): SourceRange | undefined {
    if (!Array.isArray(value) || value.length !== 5) return;
    const [file, startLine, start, endLine, end] = value;
    if (typeof file !== 'string' || !lines(file)) return;
    const coordinate = (value: unknown): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    if (!coordinate(startLine) || !coordinate(start) || !coordinate(endLine) || !coordinate(end)) return;
    const text = lines(file)!;
    if (endLine >= text.length || startLine > endLine) return;
    function column(row: string, position: number): number | undefined {
      if (language === 'java') {
        if (position <= row.length && !/[\uDC00-\uDFFF]/.test(row[position] ?? '')) return position;
      } else {
        if (/^[\x00-\x7f]*$/.test(row)) return position <= row.length ? position : undefined;
        let codeUnits = 0, points = 0;
        for (const point of row) {
          if (points === position) break;
          points++;
          codeUnits += point.length;
        }
        if (points === position) return codeUnits;
      }
    }
    const startColumn = column(text[startLine], start), endColumn = column(text[endLine], end);
    if (startColumn === undefined || endColumn === undefined || startLine === endLine && endColumn <= startColumn) return;
    return { file, startLine, startColumn, endLine, endColumn };
  }
  const declarationKey = (at: SourceRange) => JSON.stringify([at.file, at.startLine, at.startColumn, at.endLine, at.endColumn]);
  const declarations = new Map<string, CallableNode>();
  const packages = new Map<string, string>();
  for (const row of input.packages) {
    const [key, name, sources] = tuple(row);
    if (language === 'go' && typeof key === 'string' && key.length <= 1024 && typeof name === 'string' &&
      /^[\w][\w./~+-]*$/.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..') &&
      Array.isArray(sources) && sources.length && sources.every(file =>
        typeof file === 'string' && verified.has(file))) {
      packages.set(key, name);
    } else rejected = true;
  }
  for (const row of input.callables) {
    const [location, name, kind] = tuple(row);
    const at = range(location);
    const mode = at && nodes.get(at.file)?.language;
    if (!at || !verified.has(at.file) || !mode || typeof name !== 'string' || !name || name.length > 1024 ||
      !callableKinds.has(kind as CallableNode['kind'])) { rejected = true; continue; }
    const key = declarationKey(at);
    declarations.set(key, { id: JSON.stringify([mode, key, kind]), name: name.split(/[.:]+/).at(-1) || name,
      qualifiedName: name, kind: kind as CallableNode['kind'], language: mode, file: at.file, declaration: at });
  }
  const edges = new Map<string, GraphEdge>();
  const edgeSites = new Map<string, Set<string>>();
  for (const row of input.dependencies) {
    const [location, supplier, relation] = tuple(row);
    const at = range(location);
    const kind = relation === 'package' ? 'import' : relation as DependencyKind;
    if (!at || typeof supplier !== 'string' || !fileKinds.has(kind) || !verified.has(at.file) && kind !== 'include') {
      rejected = true;
      continue;
    }
    let target = supplier;
    if (relation === 'package') {
      const name = packages.get(supplier);
      if (!name) { rejected = true; continue; }
      target = 'package:go:' + supplier;
      nodes.set(target, { id: target, path: name, name, language: 'go', kind: 'package' });
    } else if (!lines(supplier)) { rejected = true; continue; }
    if (target === at.file) continue;
    const key = JSON.stringify([at.file, target]);
    const unique = JSON.stringify([kind, declarationKey(at)]);
    const sites = edgeSites.get(key) ?? new Set<string>();
    if (sites.has(unique)) continue;
    sites.add(unique);
    edgeSites.set(key, sites);
    const edge = edges.get(key);
    if (!edge) edges.set(key, { from: at.file, to: target, kind, evidence: [at] });
    else if (edge.kind === kind) edge.evidence!.push(at);
    else ((edge.additionalEvidence ??= {})[kind] ??= []).push(at);
  }
  const callEdges = new Map<string, FunctionGraph['edges'][number]>();
  const seenSites = new Set<string>();
  for (const row of input.calls) {
    const [location, enclosing, destination, kind, reason, candidate, selected] = tuple(row);
    const at = range(location);
    const lookup = (value: unknown) => {
      const location = range(value);
      return location && declarations.get(declarationKey(location));
    };
    const caller = lookup(enclosing), target = lookup(destination), possible = lookup(candidate);
    const after = (line: number, column: number, otherLine: number, otherColumn: number) =>
      line > otherLine || line === otherLine && column > otherColumn;
    if (!at || !verified.has(at.file) || kind !== 'call' && kind !== 'construct' ||
      enclosing != null && (!caller || caller.file !== at.file) || destination != null && (!target || reason != null)) {
      rejected = true;
      continue;
    }
    if (caller && (after(caller.declaration.startLine, caller.declaration.startColumn, at.startLine, at.startColumn)
      || after(at.endLine, at.endColumn, caller.declaration.endLine, caller.declaration.endColumn))) {
      rejected = true;
      continue;
    }
    const key = JSON.stringify([caller?.id, target?.id, kind]);
    const siteKey = JSON.stringify([key, declarationKey(at), possible?.id]);
    if (seenSites.has(siteKey)) continue;
    seenSites.add(siteKey);
    if (target) {
      const signature = range(selected);
      const site = { at, target: target.declaration, ...(signature && { signature }) };
      if (!caller) result.functions.moduleCalls.push({ ...site, callee: target.id, kind });
      else {
        const edge = callEdges.get(key) ?? { id: key, caller: caller.id, callee: target.id, kind, sites: [] };
        edge.sites.push(site);
        callEdges.set(key, edge);
      }
    } else if (typeof reason === 'string') {
      result.functions.unresolved.push({ at, caller: caller?.id, status: possible ? 'ambiguous' : 'unresolved',
        reason: cleanDiagnostic(reason), ...(possible && { candidates: [possible.id] }) });
    }
  }
  const compare = (a: SourceRange, b: SourceRange) => a.file.localeCompare(b.file) || a.startLine - b.startLine ||
    a.startColumn - b.startColumn || a.endLine - b.endLine || a.endColumn - b.endColumn;
  for (const edge of edges.values()) {
    edge.evidence?.sort(compare);
    for (const sites of Object.values(edge.additionalEvidence ?? {})) sites.sort(compare);
  }
  for (const edge of callEdges.values()) edge.sites.sort((a, b) => compare(a.at, b.at));
  result.nodes = [...nodes.values()];
  result.edges = [...edges.values()];
  result.functions.nodes = [...declarations.values()];
  result.functions.edges = [...callEdges.values()];
  result.functions.moduleCalls.sort((a, b) => compare(a.at, b.at) || a.callee.localeCompare(b.callee));
  result.functions.unresolved.sort((a, b) => compare(a.at, b.at) || a.reason.localeCompare(b.reason));
  const diagnostics = new Set(input.diagnostics.filter((item): item is string => typeof item === 'string').slice(0, 100).map(cleanDiagnostic));
  if (rejected) diagnostics.add('Some analyzer evidence did not match the verified workspace or result contract.');
  if (files.length > verified.size) diagnostics.add('Some discovered source files were outside the analyzer’s verified coverage.');
  result.functions.coverage = verified.size ? 'partial' : 'unavailable';
  const verifiedModes = new Set(result.nodes.filter(node => verified.has(node.id)).map(node => node.language));
  for (const mode of verifiedModes) if (mode && !result.coverage.some(item => item.language === mode)) {
    result.coverage.push({ language: mode, root: '.', analyzer: nativeTools[language], status: 'partial', diagnostics: [] });
  }
  for (const coverage of result.coverage) {
    coverage.status = verifiedModes.has(coverage.language) ? 'partial' : 'unavailable';
    coverage.diagnostics = [...diagnostics].sort();
  }
  return result;
}

function cleanDiagnostic(message: string): string {
  return message.slice(0, 300).replace(/[\x00-\x1f]/g, ' ')
    .replace(/(^|[\s("'=])(?:[a-z]:[\\/]|\/)[^\s]+/gi, '$1[path]');
}
