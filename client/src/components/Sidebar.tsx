import type { InputMode, View } from '../types';
import type { ViewNode } from '../graphView';

interface Props {
  inputMode: InputMode;
  loading: boolean;
  onInputMode: (mode: InputMode) => void;
  onAnalyze: (url: string) => void;
  onFolder: () => void;
  view: View;
  onView: (view: View) => void;
  search: string;
  onSearch: (query: string) => void;
  results: ViewNode[];
  moreResults: boolean;
  onFocus: (id: string) => void;
  cycles: string[][];
  cycle: string;
  onCycle: (cycle: string) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}

export default function Sidebar({
  inputMode, loading, onInputMode, onAnalyze, onFolder, view, onView,
  search, onSearch, results, moreResults, onFocus, cycles, cycle, onCycle,
  onZoomIn, onZoomOut, onFit,
}: Props) {
  return (
    <aside className="explorer-sidebar" aria-label="Repository and graph navigation">
      <div className="sidebar-header">
        <img src="/cockpit.svg" alt="Cockpit" className="sidebar-logo" />
      </div>
      <div className="source-controls">
        <div className="source-body">
          <div className="segmented" aria-label="Source type">
            <button type="button" aria-pressed={inputMode === 'github'} onClick={() => onInputMode('github')}>GitHub</button>
            <button type="button" aria-pressed={inputMode === 'folder'} onClick={() => onInputMode('folder')}>Local folder</button>
          </div>
          <form hidden={inputMode !== 'github'} onSubmit={event => {
            event.preventDefault();
            const url = new FormData(event.currentTarget).get('repository');
            if (typeof url === 'string' && url.trim()) onAnalyze(url.trim());
          }}>
            <label className="field-label" htmlFor="github-url-input">Repository URL</label>
            <input id="github-url-input" name="repository" placeholder="https://github.com/owner/repo" required disabled={loading} />
            <button className="primary-button" type="submit" disabled={loading}>Analyze repository</button>
          </form>
          {inputMode === 'folder' && (
            <button className="primary-button" type="button" disabled={loading} onClick={onFolder}>Select folder</button>
          )}
        </div>
      </div>

      <div className="explorer-controls">
        <div className="segmented" aria-label="Dependency level">
          <button type="button" aria-pressed={view === 'files'} onClick={() => onView('files')}>Files</button>
          <button type="button" aria-pressed={view === 'functions'} onClick={() => onView('functions')}>Functions</button>
        </div>
        <label className="field-label" htmlFor="node-search-input">
          {view === 'files' ? 'Search files' : 'Search functions'}
        </label>
        <div className="search-input">
          <input id="node-search-input" type="search" value={search} onChange={event => onSearch(event.target.value)}
            placeholder={view === 'files' ? 'Filename or path' : 'Name, scope or path'}
            onKeyDown={event => {
              if (event.key === 'Enter' && results[0]) onFocus(results[0].id);
              if (event.key === 'Escape' && search) {
                event.stopPropagation();
                onSearch('');
              }
            }} />
        </div>
        {view === 'files' && cycles.length > 0 && (
          <div className="cycle-filter">
            <label className="field-label" htmlFor="cycle-select-filter">Circular dependencies</label>
            <select id="cycle-select-filter" value={cycle} onChange={event => onCycle(event.target.value)}>
              <option value="">All files</option>
              {cycles.map((ids, i) => <option key={i} value={i}>{ids.length} {ids.length === 1 ? 'file' : 'files'} · {ids[0]}</option>)}
            </select>
          </div>
        )}
        <div className="sidebar-canvas-tools" aria-label="Graph controls">
          <button type="button" className="quiet-button" aria-label="Zoom in" title="Zoom in" onClick={onZoomIn}>+</button>
          <button type="button" className="quiet-button" aria-label="Zoom out" title="Zoom out" onClick={onZoomOut}>−</button>
          <button type="button" className="quiet-button" title="Fit visible graph" onClick={onFit}>Fit</button>
        </div>
      </div>
      {search.trim() && (
        <div className="search-results" aria-label="Search results">
          {results.length ? (
            <ul>
              {results.map(node => (
                <li key={node.id}>
                  <button type="button" onClick={() => onFocus(node.id)}>
                    <strong>{node.label}</strong><small>{node.detail}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p role="status">No matches.</p>}
          {moreResults && <p>Refine your search for more results.</p>}
        </div>
      )}
    </aside>
  );
}
