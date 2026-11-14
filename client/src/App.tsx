import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { Core } from 'cytoscape';
import sampleGraph from './sample-graph.json';
import { filterFileList, walkDirectoryHandle } from './folderScanner';
import type { FolderHandle, ScannedFile } from './folderScanner';
import type { GraphData, InputMode, Selection, View } from './types';
import { analyze, readGraph } from './graphData';
import { EDGE_LIMIT, edgeKey, indexGraphs, languageName, location, NODE_LIMIT, projectGraph } from './graphView';
import Sidebar from './components/Sidebar';
import FileInspector from './components/FileInspector';
import './App.css';

const GraphCanvas = lazy(() => import('./components/GraphCanvas'));
const sample = readGraph(sampleGraph);
const resultLimit = 40;
const uploadLimit = 50 * 1024 * 1024;

interface Exploration {
  selection: Selection;
  focus?: string;
  depth: number;
}

const overview: Exploration = { selection: null, depth: 1 };

export default function App() {
  const cyRef = useRef<Core | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [inputMode, setInputMode] = useState<InputMode>('github');
  const [source, setSource] = useState({ graph: sample, name: 'Sample graph', revision: 0 });
  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('files');
  const [query, setQuery] = useState('');
  const [cycle, setCycle] = useState('');
  const [fileState, setFileState] = useState<Exploration>(overview);
  const [functionState, setFunctionState] = useState<Exploration>(overview);
  const [functionFile, setFunctionFile] = useState<string>();

  const { graph } = source;
  const indexed = useMemo(() => indexGraphs(graph), [graph]);
  const index = indexed[view];
  const state = view === 'files' ? fileState : functionState;
  const setState = view === 'files' ? setFileState : setFunctionState;
  const functionGraph = graph.functionGraph;
  const selectedFile = fileState.selection?.kind === 'node' ? fileState.selection.id : undefined;
  const selectedNode = state.selection?.kind === 'node' ? index.byId.get(state.selection.id) : undefined;
  const selectedEdge = state.selection?.kind === 'edge' ? index.byEdge.get(state.selection.id) : undefined;
  const currentCycle = cycle ? graph.analysis.cycles[Number(cycle)] : undefined;
  const cycleEdges = useMemo(() => currentCycle && new Set(currentCycle.map((id, i) =>
    edgeKey(id, currentCycle[(i + 1) % currentCycle.length]))), [currentCycle]);
  const scopedFunctions = functionFile ? indexed.functionsByFile.get(functionFile) : undefined;
  const large = index.nodes.length > NODE_LIMIT || index.edges.length > EDGE_LIMIT;

  const visible = useMemo(() => {
    const endpoints = selectedEdge ? [selectedEdge.source, selectedEdge.target] : [];
    if (view === 'files') {
      const roots = currentCycle ?? (large && state.focus ? [state.focus] : undefined);
      const priority = currentCycle ? [] : [...endpoints, ...(state.focus ? [state.focus] : [])];
      return projectGraph(index, roots, state.depth, priority, cycleEdges, selectedEdge?.id);
    }
    const roots = [...new Set([
      ...(state.focus ? [state.focus] : []),
      ...endpoints,
      ...(scopedFunctions ?? []),
    ])];
    return projectGraph(index, roots, state.depth, roots.slice(0, endpoints.length + (state.focus ? 1 : 0)),
      undefined, selectedEdge?.id, !!scopedFunctions);
  }, [view, currentCycle, large, state.focus, state.depth, scopedFunctions, index, selectedEdge, cycleEdges]);

  const results = useMemo(() => {
    const match = query.trim().toLowerCase();
    if (!match) return [];
    const exact = [], partial = [];
    for (const node of index.nodes) {
      const label = node.label.toLowerCase();
      if (label === match || node.callable?.name.toLowerCase() === match || node.file.toLowerCase() === match) exact.push(node);
      else if (label.includes(match) || node.detail.toLowerCase().includes(match)) partial.push(node);
      if (exact.length > resultLimit && partial.length > resultLimit) break;
    }
    return [...exact.slice(0, resultLimit + 1), ...partial.slice(0, resultLimit + 1)].slice(0, resultLimit + 1);
  }, [index, query]);

  function reset() {
    setState(overview);
    setQuery('');
    if (view === 'files') setCycle('');
  }

  function closeInspector() {
    select(null);
    requestAnimationFrame(() => document.getElementById('node-search-input')?.focus());
  }

  function toggleView(next: View) {
    if (next === 'functions' && view === 'files' && selectedFile && selectedFile !== functionFile) {
      exploreFunctions(selectedFile);
    } else switchView(next);
  }

  function select(selection: Selection) {
    if (!selection) {
      reset();
      return;
    }
    setState(previous => {
      if (selection.kind === 'node' && index.byId.has(selection.id)) {
        return { ...previous, selection, focus: selection.id };
      }
      if (selection.kind === 'edge' && index.byEdge.has(selection.id)) return { ...previous, selection };
      return previous;
    });
  }

  function focus(id: string) {
    if (view === 'files' && currentCycle && !currentCycle.includes(id)) setCycle('');
    select({ kind: 'node', id });
  }

  function switchView(next: View) {
    if (view === next) return;
    const file = selectedFile;
    if (next === 'functions' && file && !functionFile) setFunctionFile(file);
    setQuery('');
    setView(next);
  }

  function exploreFunctions(file: string, call?: string) {
    setFunctionFile(file);
    setFunctionState(call ? { ...overview, selection: { kind: 'edge', id: call } } : overview);
    setQuery('');
    setView('functions');
  }

  function openFile(file: string) {
    if (!indexed.files.byId.has(file)) return;
    setFileState({ ...overview, focus: file, selection: { kind: 'node', id: file } });
    if (currentCycle && !currentCycle.includes(file)) setCycle('');
    setQuery('');
    setView('files');
  }

  function receive(data: GraphData, name: string) {
    setSource(previous => ({ graph: data, name, revision: previous.revision + 1 }));
    setView('files');
    setFileState(overview);
    setFunctionState(overview);
    setFunctionFile(undefined);
    setQuery('');
    setCycle('');
  }

  async function analyzeGithub(url: string) {
    if (loading) return;
    setLoading('Cloning and analyzing repository…');
    setError('');
    try {
      const data = await analyze(fetch('/api/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoUrl: url }),
      }));
      receive(data, url.replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, ''));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The repository could not be analyzed.');
    } finally {
      setLoading('');
    }
  }

  async function upload(files: ScannedFile[], name: string) {
    setError('');
    try {
      if (!files.length) throw new Error('No supported source or configuration files were found.');
      const bytes = files.reduce((total, entry) => total + entry.file.size, 0);
      if (bytes > uploadLimit) throw new Error('The selected files exceed the 50 MB upload limit.');
      setLoading('Packaging selected files…');
      const { createZipBundle } = await import('./zipBundle');
      const form = new FormData();
      form.append('bundle', await createZipBundle(files), name + '.zip');
      setLoading('Analyzing local folder…');
      receive(await analyze(fetch('/api/analyze-upload', { method: 'POST', body: form })), name);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The folder could not be analyzed.');
    } finally {
      setLoading('');
    }
  }

  async function pickFolder() {
    if (loading) return;
    const picker = (window as Window & {
      showDirectoryPicker?: (options: { mode: 'read' }) => Promise<FolderHandle>;
    }).showDirectoryPicker;
    if (!picker) return input.current?.click();
    setLoading('Waiting for folder selection…');
    setError('');
    let folder: FolderHandle;
    try {
      folder = await picker.call(window, { mode: 'read' });
    } catch (failure) {
      setLoading('');
      if (!(failure instanceof DOMException && failure.name === 'AbortError')) input.current?.click();
      return;
    }
    setLoading('Scanning local folder…');
    setError('');
    try {
      await upload(await walkDirectoryHandle(folder), folder.name);
    } catch {
      setLoading('');
      setError('The selected folder could not be read.');
    }
  }

  function folderChanged(event: ChangeEvent<HTMLInputElement>) {
    const files = event.currentTarget.files;
    if (!files?.length || loading) return;
    const name = files[0].webkitRelativePath.split('/')[0] || 'Local folder';
    const filtered = filterFileList(files);
    event.currentTarget.value = '';
    void upload(filtered, name);
  }

  function changeCycle(value: string) {
    setCycle(value);
    setFileState(overview);
  }

  function setInspection(edge: string) {
    const relationship = index.byEdge.get(edge);
    if (currentCycle && relationship && !cycleEdges?.has(edge) && view === 'files') setCycle('');
    select({ kind: 'edge', id: edge });
  }

  const title = view === 'files' ? 'File dependencies' : 'Function calls';
  const partial = functionGraph?.coverage === 'partial';
  const unavailable = !functionGraph || functionGraph.coverage === 'unavailable';
  const noGraph = view === 'files'
    ? 'No supported source files were found.'
    : unavailable && !index.nodes.length ? 'Function analysis is unavailable for this result.'
    : functionFile && !scopedFunctions?.length ? 'No callables were found in this file. Search to explore another file.'
    : !index.nodes.length ? 'No callable declarations were found.' : 'Search for a function or explore functions from a file.';
  const callsForEdge = view === 'files' && selectedEdge
    ? indexed.callsByFilePair.get(edgeKey(selectedEdge.source, selectedEdge.target)) ?? []
    : [];
  const unresolved = selectedNode && view === 'functions'
    ? indexed.unresolvedByCaller.get(selectedNode.id) ?? [] : [];

  return (
    <div className="app-container" onKeyDown={event => {
      if (event.key === 'Escape' && state.selection) select(null);
    }}>
      <input ref={element => {
        input.current = element;
        element?.setAttribute('webkitdirectory', '');
      }} type="file" multiple hidden
        aria-label="Select a local project folder" onChange={folderChanged} />
      {loading && <div className="notice" role="status">{loading}</div>}
      {error && <div className="notice error-notice" role="alert">
        <span>{error}</span><button type="button" className="quiet-button" onClick={() => setError('')} aria-label="Dismiss error">×</button>
      </div>}
      <div className="workspace-container">
        <Sidebar inputMode={inputMode} loading={!!loading} onInputMode={setInputMode} onAnalyze={analyzeGithub} onFolder={pickFolder}
          view={view} onView={toggleView} search={query} onSearch={setQuery}
          results={results.slice(0, resultLimit)} moreResults={results.length > resultLimit} onFocus={focus}
          cycles={graph.analysis.cycles} cycle={cycle} onCycle={changeCycle}
          onZoomIn={() => changeZoom(1.25)} onZoomOut={() => changeZoom(0.8)} onFit={() => cyRef.current?.fit(undefined, 28)} />
        <main className="graph-workspace" aria-label={title}>
          <h1 className="sr-only">{title}</h1>

          {!!graph.languageCoverage?.length && <div className="coverage">
            <details>
              <summary>Language coverage</summary>
              <div className="coverage-body"><ul className="evidence-list">
                {graph.languageCoverage.map(item => <li key={item.language + ':' + item.root}>
                  <strong>{languageName[item.language]} · {item.status}</strong>
                  <code>{item.root} · {item.analyzer}</code>
                  {item.diagnostics.map(message => <p key={message}>{message}</p>)}
                </li>)}
              </ul></div>
            </details>
          </div>}
          {view === 'functions' && (partial || unavailable) && <div className="coverage">
            <details>
              <summary>{unavailable ? 'Function analysis unavailable' : 'Partial function analysis'}</summary>
              {functionGraph ? <Coverage key={source.revision} graph={functionGraph} /> : <p>Analyze a repository to load callable data.</p>}
            </details>
          </div>}
          {visible.limited && <p className="graph-message" role="status">
            {visible.nodes.length < index.nodes.length
              ? 'Showing ' + visible.nodes.length + ' of ' + index.nodes.length + (view === 'functions' ? ' callables.'
                : graph.nodes.some(node => node.kind === 'package') ? ' files and packages.' : ' files.')
              : 'Some relationships are outside this view.'}
            {' '}Use search or the inspector to keep exploring.
          </p>}
          {visible.nodes.length > 0 && !visible.edges.length && <p className="graph-message">
            {view === 'files' ? 'No resolved dependencies in this view.' : 'No resolved calls in this view.'}
          </p>}

          <div className="canvas-frame">
            <Suspense fallback={<div className="layout-status" role="status">Loading graph…</div>}>
              <GraphCanvas cyRef={cyRef} nodes={visible.nodes} edges={visible.edges} selection={state.selection}
                onSelect={select} viewKey={source.revision + ':' + view} />
            </Suspense>
            {(view === 'functions' || visible.canExpand) && (
              <div className="view-actions">
                {view === 'functions' && <button type="button" className="quiet-button" onClick={() => switchView('files')}>Back to files</button>}
                {visible.canExpand && <button type="button" className="quiet-button"
                  onClick={() => setState(previous => ({ ...previous, depth: previous.depth + 1 }))}>Expand neighborhood</button>}
              </div>
            )}
            {!visible.nodes.length && <div className="graph-empty" role="status">{noGraph}</div>}
          </div>
        </main>
        <FileInspector view={view} index={index} selection={state.selection} unresolved={unresolved}
          canExplore={!!functionGraph && functionGraph.coverage !== 'unavailable'}
          canOpenFile={file => indexed.files.byId.has(file)} onClose={closeInspector}
          onFocus={focus} onEdge={setInspection} onFunctions={exploreFunctions} onFile={openFile}
          callsForEdge={callsForEdge} functions={indexed.functions}
          moduleCalls={view === 'files' && selectedNode ? indexed.moduleCallsByFile.get(selectedNode.id) ?? [] : []} />
      </div>
    </div>
  );

  function changeZoom(factor: number) {
    const cy = cyRef.current;
    if (cy) cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  }
}

function Coverage({ graph }: { graph: NonNullable<GraphData['functionGraph']> }) {
  const [limit, setLimit] = useState(20);
  const diagnostics = graph.diagnostics;
  const total = diagnostics.length + graph.unresolved.length;
  return (
    <div className="coverage-body">
      <p>{total
        ? 'Only resolved calls appear as graph edges. ' + graph.unresolved.length + ' ambiguous or unresolved call sites.'
        : 'The response contains no further coverage details.'}</p>
      <ul className="evidence-list">
        {diagnostics.slice(0, limit).map((item, i) => <li key={'diagnostic-' + i}>
          <strong>{item.code ? 'TS' + item.code : 'Analysis'}</strong>{item.reason}
          {item.at && <code>{location(item.at)}</code>}
        </li>)}
        {graph.unresolved.slice(0, Math.max(0, limit - diagnostics.length)).map((item, i) => <li key={'call-' + i}>
          <strong>{item.status === 'ambiguous' ? 'Ambiguous' : 'Unresolved'}</strong>{item.reason}
          <code>{location(item.at)}</code>
        </li>)}
      </ul>
      {total > limit && <button type="button" className="quiet-button" onClick={() => setLimit(value => value + 20)}>More diagnostics</button>}
    </div>
  );
}
