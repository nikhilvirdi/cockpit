import * as fs from 'fs';
import * as path from 'path';
import { fromBinary } from '@bufbuild/protobuf';
import { BinaryReader, WireType } from '@bufbuild/protobuf/wire';
import type { Document, Index, Occurrence } from '@scip-code/scip' with { "resolution-mode": "import" };
import type { Parser } from '@vscode/tree-sitter-wasm';
import type {
  CallableNode, FunctionGraph, GraphEdge, GraphNode, IndexedLanguage, LanguageCoverage, SourceRange
} from './types';
import { contains, openParser, readSyntax, sourcePositions } from './scipSyntax';
import type { Span, SyntaxCallable } from './scipSyntax';
import { toPosixPath } from './scanner';

const maxIndexBytes = 12 * 1024 * 1024;
const maxFileBytes = 1024 * 1024;
const maxSourceBytes = 30 * 1024 * 1024;
const maxDocuments = 5000;
const maxOccurrences = 200_000;
// SCIP's protocol enum values. The bindings are ESM-only and loaded on demand.
const definitionRole = 1;
const packageKind = 35;
const methodSpecificationKind = 67;

export const indexerNames: Record<IndexedLanguage, string> = {
  python: 'scip-python', go: 'scip-go', java: 'scip-java', c: 'scip-clang', cpp: 'scip-clang'
};

export interface IndexedProject {
  root: string;
  language: IndexedLanguage;
  files: Array<GraphNode & { language: IndexedLanguage }>;
}

export interface LanguageResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  functions: FunctionGraph;
  coverage: LanguageCoverage[];
}

export type IndexProvider = (project: IndexedProject, signal?: AbortSignal) => Promise<string | undefined>;
export type LanguageAdapter = (project: IndexedProject, options: {
  workspace: string; index?: string; signal?: AbortSignal; missing?: string; decoded?: Map<string, Promise<Index>>
}) => Promise<LanguageResult>;

const emptyFunctions = (): FunctionGraph => ({
  nodes: [], edges: [], moduleCalls: [], unresolved: [], diagnostics: [], coverage: 'unavailable'
});

export function unavailable(project: IndexedProject, workspace: string, reason: string): LanguageResult {
  return { nodes: project.files, edges: [], functions: emptyFunctions(), coverage: projectCoverage(project).map(language => ({
    root: toPosixPath(path.relative(workspace, project.root)) || '.', language,
    analyzer: indexerNames[language], status: 'unavailable', diagnostics: [reason]
  })) };
}

function projectCoverage(project: IndexedProject): IndexedLanguage[] {
  const languages = project.files.map(file => file.language);
  return languages.length ? [...new Set(languages)] : [project.language];
}

export async function readIndex(file: string): Promise<Index> {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size === 0 || stat.size > maxIndexBytes) throw new Error('SCIP index is empty, oversized or not a regular file.');
  let index: Index;
  try {
    const { IndexSchema } = await import('@scip-code/scip');
    const bytes = fs.readFileSync(file);
    checkIndexLimits(bytes);
    index = fromBinary(IndexSchema, bytes, { readUnknownFields: false, recursionLimit: 32 });
  } catch {
    throw new Error('Malformed SCIP protobuf or index exceeds structural limits.');
  }
  if (!index.metadata || index.metadata.version !== 0 || !index.documents.length || index.documents.length > maxDocuments) {
    throw new Error('SCIP index has missing metadata, an unsupported version, or an invalid document count.');
  }
  return index;
}

function checkIndexLimits(bytes: Uint8Array) {
  // Check repeated message counts before the decoder allocates objects for them.
  const index = new BinaryReader(bytes);
  let documents = 0, entries = 0;
  while (index.pos < index.len) {
    const [field, wire] = index.tag();
    if (field === 2 && wire === WireType.LengthDelimited) {
      if (++documents > maxDocuments) throw new Error();
      const document = new BinaryReader(index.bytes());
      while (document.pos < document.len) {
        const [documentField, documentWire] = document.tag();
        if ((documentField === 2 || documentField === 3) && ++entries > maxOccurrences) throw new Error();
        document.skip(documentWire, documentField, 32);
      }
    } else {
      if (field === 3 && ++entries > maxOccurrences) throw new Error();
      index.skip(wire, field, 32);
    }
  }
}

function relativeDocument(value: string): string | undefined {
  const normalized = toPosixPath(value);
  if (normalized.includes(':') || normalized.includes('\0') || normalized.split('/').some(part => !part || part === '.' || part === '..')) return;
  return normalized;
}

// Some producers leave the encoding unspecified. Use the convention verified for each producer.
function encoding(document: Document, index: Index) {
  if ([1, 2, 3].includes(document.positionEncoding)) return document.positionEncoding;
  if (document.positionEncoding !== 0) return undefined;
  const name = index.metadata?.toolInfo?.name;
  if (name === 'scip-python' || name === 'scip-java') return 2;
  if (name === 'scip-clang' || name === 'scip-go') return 1;
  return undefined;
}

function occurrenceSpan(item: Occurrence, positions: ReturnType<typeof sourcePositions>, units: number): Span | undefined {
  const typed = item.typedRange;
  let coordinates: number[];
  if (typed.case === 'singleLineRange') {
    const { line, startCharacter, endCharacter } = typed.value;
    coordinates = [line, startCharacter, line, endCharacter];
  } else if (typed.case === 'multiLineRange') {
    const { startLine, startCharacter, endLine, endCharacter } = typed.value;
    coordinates = [startLine, startCharacter, endLine, endCharacter];
  } else if (item.range.length === 3) {
    coordinates = [item.range[0], item.range[1], item.range[0], item.range[2]];
  } else if (item.range.length === 4) coordinates = item.range;
  else return;
  const start = positions.offset(coordinates[0], coordinates[1], units);
  const end = positions.offset(coordinates[2], coordinates[3], units);
  if (start !== undefined && end !== undefined && end >= start) return { start, end };
}

type Occ = Span & { symbol: string; definition: boolean };

function parseDocument(parser: Parser, file: GraphNode, language: IndexedLanguage, document: Document, units: number) {
  const bytes = fs.readFileSync(file.path);
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (document.text && document.text !== source) throw new Error('SCIP document text differs from the source snapshot.');
  const positions = sourcePositions(file.id, source);
  const tree = parser.parse(source);
  if (!tree) throw new Error('Tree-sitter could not parse this source file.');
  try {
    const syntax = readSyntax(tree, language);
    const lookup = new Map<string, Occ[]>();
    const symbolKinds = new Map(document.symbols.map(symbol => [symbol.symbol, symbol.kind]));
    let invalid = 0;
    const occurrences: Occ[] = [];
    for (const item of document.occurrences) {
      if (!item.symbol) continue;
      const at = occurrenceSpan(item, positions, units);
      if (!at) { invalid++; continue; }
      const symbol = item.symbol.startsWith('local ') ? JSON.stringify([file.id, item.symbol]) : item.symbol;
      const occurrence = { ...at, symbol, definition: !!(item.symbolRoles & definitionRole) };
      occurrences.push(occurrence);
      const key = JSON.stringify([at.start, at.end]);
      const group = lookup.get(key);
      if (group) group.push(occurrence);
      else lookup.set(key, [occurrence]);
    }
    positions.clearOffsets();
    occurrences.sort((a, b) => a.start - b.start || a.end - b.end);
    function inside(span: Span) {
      let low = 0, high = occurrences.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (occurrences[mid].start < span.start) low = mid + 1;
        else high = mid;
      }
      const matches = [];
      for (let i = low; i < occurrences.length && occurrences[i].start < span.end; i++) {
        if (contains(span, occurrences[i])) matches.push(occurrences[i]);
      }
      return matches;
    }
    return { file: file.id, language, syntax, lookup, occurrences, symbolKinds, inside, positions, invalid };
  } finally {
    tree.delete();
  }
}

function append<K, V>(index: Map<K, V[]>, key: K, value: V) {
  const group = index.get(key);
  if (group) group.push(value);
  else index.set(key, [value]);
}

function packageName(symbol: string): string {
  const descriptor = symbol.split(' ').slice(4).join(' ').replace(/\/$/, '');
  return descriptor.startsWith('\x60') && descriptor.endsWith('\x60') ? descriptor.slice(1, -1) : descriptor;
}

type Definition = { file: string; package: boolean };
type CallableDefinition = { node: CallableNode; syntax: SyntaxCallable; signature?: SourceRange };

export const analyzeScip: LanguageAdapter = async (project, { workspace, index: indexPath, signal, missing, decoded }) => {
  if (!indexPath) return unavailable(project, workspace, missing ?? 'No SCIP index is available.');
  let index: Index;
  try {
    let pending = decoded?.get(indexPath);
    if (!pending) {
      pending = readIndex(indexPath);
      decoded?.set(indexPath, pending);
    }
    index = await pending;
  } catch (error) {
    return unavailable(project, workspace, error instanceof Error && !('code' in error)
      ? error.message : 'Could not read the SCIP index.');
  }
  const expected = indexerNames[project.language];
  if (index.metadata?.toolInfo?.name !== expected) {
    return unavailable(project, workspace, 'The SCIP index was not produced by ' + expected + '.');
  }

  const files = new Map(project.files.map(file => [toPosixPath(path.relative(project.root, file.path)), file]));
  const parsed: ReturnType<typeof parseDocument>[] = [];
  const diagnostics = new Set<string>();
  const limitsByLanguage = new Map<IndexedLanguage, number>();
  const seen = new Set<string>();
  let sourceBytes = 0;
  const parsers = new Map<IndexedLanguage, Parser>();
  try {
    for (const document of index.documents) {
      signal?.throwIfAborted();
      const relative = relativeDocument(document.relativePath);
      if (!relative) { diagnostics.add('The index contains unsafe document paths.'); continue; }
      const file = files.get(relative);
      if (!file) continue;
      if (seen.has(relative)) { diagnostics.add('The index contains duplicate source documents.'); continue; }
      seen.add(relative);
      const units = encoding(document, index);
      if (!units) { diagnostics.add('A document uses an unsupported position encoding.'); continue; }
      const language = file.language;
      let parser = parsers.get(language);
      if (!parser) {
        parser = await openParser(language);
        parsers.set(language, parser);
      }
      try {
        const stat = fs.statSync(file.path);
        sourceBytes += stat.size;
        if (stat.size > maxFileBytes || sourceBytes > maxSourceBytes) {
          diagnostics.add('Source bytes exceeded the SCIP analysis limit.');
          continue;
        }
        const result = parseDocument(parser, file, language, document, units);
        parsed.push(result);
        limitsByLanguage.set(language, (limitsByLanguage.get(language) ?? 0) + 1);
        if (result.syntax.hasErrors) diagnostics.add('Tree-sitter reported syntax errors in ' + file.id + '.');
        if (result.invalid) diagnostics.add('The index contains source ranges outside ' + file.id + '.');
      } catch {
        diagnostics.add('The indexed source could not be parsed or matched to the snapshot: ' + file.id + '.');
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    return unavailable(project, workspace, 'Tree-sitter grammar could not initialize.');
  } finally {
    for (const parser of parsers.values()) parser.delete();
  }
  if (!parsed.length) return unavailable(project, workspace, [...diagnostics, 'No indexed documents matched this project.'].join(' '));
  if (parsed.length < files.size) diagnostics.add('SCIP covers ' + parsed.length + ' of ' + files.size + ' discovered source files.');
  // shortcut: SCIP does not certify whole-project analysis, require indexer-specific coverage checks before marking complete.
  diagnostics.add('Coverage is limited to compiler-indexed syntax and statically bound targets.');

  const definitions = new Map<string, Definition[]>();
  const interfaceMethods = new Set<string>();
  const callableDefs = new Map<string, CallableDefinition[]>();
  const callableBySyntax = new Map<SyntaxCallable, CallableNode>();
  const seenCallables = new Set<string>();
  const signatureCounts = new Map<string, number>();
  const external = new Set(index.externalSymbols.map(symbol => symbol.symbol));
  const functions = emptyFunctions();
  functions.coverage = 'partial';
  const result: LanguageResult = {
    nodes: [...project.files], edges: [], functions, coverage: projectCoverage(project).map(language => ({
      language, root: toPosixPath(path.relative(workspace, project.root)) || '.',
      analyzer: expected, status: limitsByLanguage.has(language) ? 'partial' : 'unavailable', diagnostics: []
    }))
  };

  for (const document of parsed) {
    const { file, language, syntax, positions } = document;
    if (language === 'go') {
      for (const [symbol, kind] of document.symbolKinds) if (kind === methodSpecificationKind) interfaceMethods.add(symbol);
    }
    for (const occurrence of document.occurrences) {
      if (!occurrence.definition) continue;
      append(definitions, occurrence.symbol, { file,
        package: project.language === 'go' && document.symbolKinds.get(occurrence.symbol) === packageKind });
    }
    for (const callable of syntax.callables) {
      const occurrences = callable.token
        ? document.lookup.get(JSON.stringify([callable.token.start, callable.token.end])) ?? [] : [];
      const symbols = [...new Set(occurrences.filter(item => item.definition).map(item => item.symbol))];
      const declaration = positions.range(callable.at);
      const id = JSON.stringify([language, file, declaration.startLine, declaration.startColumn, callable.kind]);
      const node: CallableNode = { id, name: callable.name, qualifiedName: callable.qualifiedName, kind: callable.kind,
        file, language, declaration };
      callableBySyntax.set(callable, node);
      if (!seenCallables.has(id)) { seenCallables.add(id); functions.nodes.push(node); }
      const overload = JSON.stringify([file, node.qualifiedName]);
      signatureCounts.set(overload, (signatureCounts.get(overload) ?? 0) + 1);
      const definition = { node, syntax: callable, signature: callable.signature && positions.range(callable.signature) };
      for (const symbol of symbols) append(callableDefs, symbol, definition);
      if (project.language === 'python' && callable.owner) {
        const owner = document.lookup.get(JSON.stringify([callable.owner.start, callable.owner.end])) ?? [];
        for (const occurrence of owner) {
          if (occurrence.definition) append(callableDefs, occurrence.symbol, definition);
        }
      }
    }
  }

  const dependencies = new Map<string, GraphEdge>();
  const packageIds = new Set<string>();
  const callEdges = new Map<string, FunctionGraph['edges'][number]>();
  function dependency(from: string, to: string, kind: NonNullable<GraphEdge['kind']>, at: SourceRange) {
    if (from === to) return;
    const key = JSON.stringify([from, to]);
    const current = dependencies.get(key);
    if (current?.kind === kind) {
      const sites = current.evidence!;
      if (!sites.some(site => JSON.stringify(site) === JSON.stringify(at))) sites.push(at);
    } else if (!current) dependencies.set(key, { from, to, kind, evidence: [at] });
  }

  for (const document of parsed) {
    signal?.throwIfAborted();
    const { file, syntax, positions } = document;
    for (const statement of syntax.imports) {
      const at = positions.range(statement.at);
      let found = false;
      const occurrences = document.inside(statement.token ?? statement.at);
      for (const occurrence of occurrences) {
        if (occurrence.definition) continue;
        const targets = definitions.get(occurrence.symbol) ?? [];
        if (project.language === 'go') {
          if (!targets.some(target => target.package)) continue;
          const name = packageName(occurrence.symbol);
          if (!relativeDocument(name) || /[\\\s]/.test(name)) continue;
          const id = 'package:go:' + JSON.stringify([toPosixPath(path.relative(workspace, project.root)), name]);
          if (!packageIds.has(id)) {
            packageIds.add(id);
            result.nodes.push({ id, path: name, name, kind: 'package', language: 'go' });
          }
          dependency(file, id, 'import', at);
          found = true;
        } else {
          const unique = [...new Set(targets.map(target => target.file))];
          if (unique.length !== 1) continue;
          dependency(file, unique[0], statement.kind, at);
          found = true;
        }
      }
      if (!found && !occurrences.some(item => external.has(item.symbol))) {
        diagnostics.add('Some imports or includes have no matching project definition in SCIP.');
      }
    }

    if (document.language === 'java') {
      for (const occurrence of document.occurrences) {
        if (occurrence.definition) continue;
        const targets = definitions.get(occurrence.symbol) ?? [];
        const files = [...new Set(targets.map(target => target.file))];
        if (files.length === 1) dependency(file, files[0], 'reference', positions.range(occurrence));
      }
    }

    for (const call of syntax.calls) {
      const at = positions.range(call.at);
      const caller = call.scope && callableBySyntax.get(call.scope)?.id;
      const references = call.token ? document.lookup.get(JSON.stringify([call.token.start, call.token.end])) ?? [] : [];
      const symbols = [...new Set(references.filter(item => !item.definition).map(item => item.symbol))];
      const targets = [...new Map(symbols.flatMap(symbol => callableDefs.get(symbol) ?? [])
        .map(target => [target.node.id, target])).values()];
      const isGoInterface = document.language === 'go' && symbols.some(symbol => interfaceMethods.has(symbol));
      const ambiguous = isGoInterface || targets.length > 1 || targets.some(target => target.syntax.dispatch);
      if (!ambiguous && targets.length === 1 && (!call.scope || caller)) {
        const { node: target, signature } = targets[0];
        const kind = call.kind === 'construct' || target.kind === 'constructor' ? 'construct' : 'call';
        const overload = (signatureCounts.get(JSON.stringify([target.file, target.qualifiedName])) ?? 0) > 1;
        const site = { at, target: target.declaration, ...(overload && signature && { signature }) };
        if (!caller) functions.moduleCalls.push({ callee: target.id, kind, ...site });
        else {
          const id = JSON.stringify([caller, target.id, kind]);
          let edge = callEdges.get(id);
          if (!edge) {
            edge = { id, caller, callee: target.id, kind, sites: [] };
            callEdges.set(id, edge);
          }
          edge.sites.push(site);
        }
      } else if (ambiguous || symbols.length === 0 || !symbols.every(symbol => external.has(symbol))) {
        functions.unresolved.push({ at, caller, status: ambiguous ? 'ambiguous' : 'unresolved',
          reason: ambiguous ? 'The indexed declaration does not establish a unique runtime target.'
            : 'No matching callable definition for the indexed call token.',
          ...(targets.length && { candidates: targets.map(target => target.node.id).sort() })
        });
      }
    }
  }

  result.edges = [...dependencies.values()];
  functions.edges = [...callEdges.values()];
  for (const coverage of result.coverage) coverage.diagnostics = [...diagnostics].sort();
  return result;
};

