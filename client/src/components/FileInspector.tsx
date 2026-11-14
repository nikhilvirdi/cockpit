import type { SelectedNodeInfo, SelectedEdgeInfo, SymbolUsageItem } from '../types';

interface FileInspectorProps {
  selectedNode: SelectedNodeInfo | null;
  selectedEdge: SelectedEdgeInfo | null;
  symbolUsageByEdgeMap: Map<string, SymbolUsageItem[]>;
  onCloseNode: () => void;
  onCloseEdge: () => void;
  onFocusNode: (nodeId: string) => void;
  onSelectEdge: (edgeKey: string) => void;
}

export default function FileInspector({
  selectedNode,
  selectedEdge,
  symbolUsageByEdgeMap,
  onCloseNode,
  onCloseEdge,
  onFocusNode,
  onSelectEdge,
}: FileInspectorProps) {
  if (selectedNode) {
    return (
      <aside className="side-panel">
        <div className="panel-header">
          <div className="panel-title">
            <span>File Inspector</span>
          </div>
          <button type="button" className="panel-close-btn" onClick={onCloseNode}>✕</button>
        </div>

        <div className="panel-body">
          {/* Node Identity Card */}
          <div className="inspector-card">
            <div className="card-title">File Node</div>
            <div className="card-value" style={{ fontWeight: 600, color: 'var(--accent-info)', fontFamily: 'var(--font-mono)' }}>
              {selectedNode.id}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              {selectedNode.fullPath}
            </div>
            {selectedNode.isCycle && <span className="metric-pill danger">Cycle Member</span>}
          </div>

          {/* Outgoing Imports Card */}
          <div className="inspector-card">
            <div className="card-title">
              <span>Direct Imports ({selectedNode.outgoing.length})</span>
            </div>
            {selectedNode.outgoing.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {selectedNode.outgoing.map((outId, i) => {
                  const edgeKey = `${selectedNode.id}->${outId}`;
                  const symbols = symbolUsageByEdgeMap.get(edgeKey) || [];
                  return (
                    <div key={i} style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <button
                        type="button"
                        onClick={() => onFocusNode(outId)}
                        style={{
                          flex: 1,
                          background: 'var(--bg-input)',
                          border: '1px solid var(--border-default)',
                          color: 'var(--text-secondary)',
                          padding: '5px 8px',
                          borderRadius: 'var(--radius-sm)',
                          textAlign: 'left',
                          fontSize: '11px',
                          cursor: 'pointer',
                          fontFamily: 'var(--font-mono)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={`Inspect file ${outId}`}
                      >
                        → {outId}
                      </button>
                      <button
                        type="button"
                        onClick={() => onSelectEdge(edgeKey)}
                        title={symbols.length > 0 ? `Inspect ${symbols.length} traced symbols on this import edge` : 'Inspect import edge'}
                        style={{
                          background: symbols.length > 0 ? 'var(--node-bg)' : 'transparent',
                          border: `1px solid ${symbols.length > 0 ? 'var(--accent-info)' : 'var(--border-default)'}`,
                          color: symbols.length > 0 ? 'var(--accent-info)' : 'var(--text-muted)',
                          padding: '5px 8px',
                          borderRadius: 'var(--radius-sm)',
                          fontSize: '10px',
                          fontWeight: 500,
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {symbols.length > 0 ? `Symbols (${symbols.length})` : 'Edge'}
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No internal imports.</div>
            )}
          </div>

          {/* Incoming Consumers Card */}
          <div className="inspector-card">
            <div className="card-title">
              <span>Depended Upon By ({selectedNode.incoming.length})</span>
            </div>
            {selectedNode.incoming.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {selectedNode.incoming.map((inId, i) => {
                  const edgeKey = `${inId}->${selectedNode.id}`;
                  const symbols = symbolUsageByEdgeMap.get(edgeKey) || [];
                  return (
                    <div key={i} style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <button
                        type="button"
                        onClick={() => onFocusNode(inId)}
                        style={{
                          flex: 1,
                          background: 'var(--bg-input)',
                          border: '1px solid var(--border-default)',
                          color: 'var(--text-secondary)',
                          padding: '5px 8px',
                          borderRadius: 'var(--radius-sm)',
                          textAlign: 'left',
                          fontSize: '11px',
                          cursor: 'pointer',
                          fontFamily: 'var(--font-mono)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={`Inspect file ${inId}`}
                      >
                        ← {inId}
                      </button>
                      <button
                        type="button"
                        onClick={() => onSelectEdge(edgeKey)}
                        title={symbols.length > 0 ? `Inspect ${symbols.length} traced symbols on this import edge` : 'Inspect import edge'}
                        style={{
                          background: symbols.length > 0 ? 'var(--node-bg)' : 'transparent',
                          border: `1px solid ${symbols.length > 0 ? 'var(--accent-info)' : 'var(--border-default)'}`,
                          color: symbols.length > 0 ? 'var(--accent-info)' : 'var(--text-muted)',
                          padding: '5px 8px',
                          borderRadius: 'var(--radius-sm)',
                          fontSize: '10px',
                          fontWeight: 500,
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {symbols.length > 0 ? `Symbols (${symbols.length})` : 'Edge'}
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No incoming dependencies.</div>
            )}
          </div>
        </div>
      </aside>
    );
  }

  if (selectedEdge) {
    return (
      <aside className="side-panel">
        <div className="panel-header">
          <div className="panel-title">
            <span>Import Edge Inspector</span>
          </div>
          <button type="button" className="panel-close-btn" onClick={onCloseEdge}>✕</button>
        </div>

        <div className="panel-body">
          {/* Edge Identity Card */}
          <div className="inspector-card">
            <div className="card-title">Dependency Edge</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                Consumer File (Importing):
                <div
                  className="via-link"
                  style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, fontSize: '11px', color: 'var(--accent-info)' }}
                  onClick={() => onFocusNode(selectedEdge.source)}
                >
                  {selectedEdge.source}
                </div>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                Supplier File (Exporting):
                <div
                  className="via-link"
                  style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, fontSize: '11px', color: 'var(--accent-info)' }}
                  onClick={() => onFocusNode(selectedEdge.target)}
                >
                  {selectedEdge.target}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '6px' }}>
              {selectedEdge.isCycle && <span className="metric-pill danger">Circular Edge</span>}
              {selectedEdge.hasTracedSymbols ? (
                <span className="badge-runtime">Traced Symbols: {selectedEdge.symbolUsages.length}</span>
              ) : (
                <span className="metric-pill">Untraced Import</span>
              )}
            </div>
          </div>

          {/* Symbol Usages Breakdown Card */}
          <div className="inspector-card" id="edge-symbols-card">
            <div className="card-title">
              <span>Traced Symbols ({selectedEdge.symbolUsages.length})</span>
            </div>
            {selectedEdge.symbolUsages.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {selectedEdge.symbolUsages.map((sym, i) => (
                  <div key={i} className="symbol-usage-row">
                    <div className="symbol-name-bar">
                      <span className="symbol-name">{sym.importedSymbol}</span>
                      <span className={sym.typeOnly ? 'badge-typeonly' : 'badge-runtime'}>
                        {sym.typeOnly ? 'Type-only' : 'Runtime'}
                      </span>
                    </div>
                    <div className="symbol-meta">
                      <span>Scope: <strong style={{ color: 'var(--text-primary)' }}>{sym.usedInScope}</strong></span>
                      <span>•</span>
                      <span>Line: {sym.line}</span>
                    </div>
                    {sym.note && (
                      <div style={{ fontSize: '10px', color: 'var(--accent-warning)', fontStyle: 'italic' }}>
                        Note: {sym.note}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                No specific symbol references were traced across this import edge (barrel re-export, side-effect import, or dynamic access).
              </div>
            )}
          </div>
        </div>
      </aside>
    );
  }

  // Empty state — Repository Overview
  return (
    <aside className="side-panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>Repository Overview</span>
        </div>
      </div>

      <div className="panel-body">
        <div className="inspector-card">
          <div style={{ textAlign: 'center', padding: '12px 8px', fontSize: '11px', color: 'var(--text-muted)' }}>
            Select a file node or import edge to inspect details.
          </div>
        </div>
      </div>
    </aside>
  );
}
