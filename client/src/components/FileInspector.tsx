import type { ReactNode } from 'react';
import type { FunctionGraph, Selection, SourceRange, View } from '../types';
import { languageName, location } from '../graphView';
import type { GraphIndex, ViewEdge, ViewNode } from '../graphView';

interface Props {
  view: View;
  index: GraphIndex;
  selection: Selection;
  unresolved: FunctionGraph['unresolved'];
  canExplore: boolean;
  onClose: () => void;
  onFocus: (id: string) => void;
  onEdge: (id: string) => void;
  onFunctions: (file: string, call?: string) => void;
  onFile: (file: string) => void;
  canOpenFile: (file: string) => boolean;
  callsForEdge: ViewEdge[];
  functions: GraphIndex;
  moduleCalls: FunctionGraph['moduleCalls'];
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="inspector-section"><h3>{title}</h3>{children}</section>;
}

function Location({ range }: { range?: SourceRange }) {
  return <code className="source-location">{location(range)}</code>;
}

function Relations({ edges, index, incoming, view, onFocus, onEdge }: {
  edges: ViewEdge[]; index: GraphIndex; incoming?: boolean; view: View;
  onFocus: Props['onFocus']; onEdge: Props['onEdge'];
}) {
  if (!edges.length) return <p className="muted">None recorded.</p>;
  return (
    <ul className="relation-list">
      {edges.map(edge => {
        const node = index.byId.get(incoming ? edge.source : edge.target);
        if (!node) return null;
        const count = edge.call?.sites.length ?? edge.symbols?.length ?? 0;
        const noun = view === 'functions' ? 'call' : 'reference';
        return (
          <li key={edge.id}>
            <button type="button" className="node-link" onClick={() => onFocus(node.id)}>
              <strong>{node.label}</strong><small>{node.detail}</small>
            </button>
            <button type="button" className="quiet-button evidence-button" onClick={() => onEdge(edge.id)}
              aria-label={'Inspect ' + (view === 'functions' ? 'call' : 'dependency') + ' ' + (incoming ? 'from ' : 'to ') + node.detail}>
              {count ? count + ' ' + noun + (count === 1 ? '' : 's') : 'Inspect'}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const kindLabels: Record<string, string> = {
  function: 'Function', arrow: 'Arrow function', method: 'Method', 'static-method': 'Static method',
  constructor: 'Constructor', getter: 'Getter', setter: 'Setter',
};

function Endpoint({ role, node, onFocus }: { role: string; node: ViewNode; onFocus: Props['onFocus'] }) {
  return (
    <div className="inspector-cell">
      <span className="cell-label">{role}</span>
      <button type="button" className="node-link" onClick={() => onFocus(node.id)}>
        <strong>{node.label}</strong><small className="cell-path">{node.detail}</small>
      </button>
    </div>
  );
}

export default function FileInspector({
  view, index, selection, unresolved, canExplore, onClose, onFocus, onEdge, onFunctions, onFile, canOpenFile,
  callsForEdge, functions: callableIndex, moduleCalls,
}: Props) {
  const node = selection?.kind === 'node' ? index.byId.get(selection.id) : undefined;
  const edge = selection?.kind === 'edge' ? index.byEdge.get(selection.id) : undefined;
  const from = edge && index.byId.get(edge.source);
  const to = edge && index.byId.get(edge.target);
  if (!node && (!edge || !from || !to)) return null;
  const functions = view === 'functions';
  const title = node ? (functions ? 'Function inspector' : node.package ? 'Package inspector' : 'File inspector')
    : (functions ? 'Call inspector' : 'Dependency inspector');
  const outgoing = node ? (index.outgoing.get(node.id) ?? []) : [];
  const incoming = node ? (index.incoming.get(node.id) ?? []) : [];

  return (
    <aside className="dependency-inspector" aria-label={title}>
      <header className="inspector-header">
        <h2>{title}</h2>
        <button type="button" className="quiet-button" aria-label="Close inspector" onClick={onClose}>×</button>
      </header>
      <div className="inspector-body">
        {node && (
          <>
            {node.callable ? (
              <div className="inspector-grid" aria-label="Function summary">
                <div className="inspector-cell">
                  <span className="cell-label">Function</span>
                  <strong className="cell-value cell-truncate" title={node.label}>{node.label}</strong>
                </div>
                <div className="inspector-cell">
                  <span className="cell-label">Callees</span>
                  <span className="cell-value cell-count">{outgoing.length}</span>
                </div>
                <div className="inspector-cell inspector-cell-path">
                  <span className="cell-label">Location</span>
                  <code className="cell-value cell-path" title={node.callable.declaration ? location(node.callable.declaration) : node.file}>
                    {node.callable.declaration ? location(node.callable.declaration) : node.file}
                  </code>
                </div>
                <div className="inspector-cell">
                  <span className="cell-label">Callers</span>
                  <span className="cell-value cell-count">{incoming.length}</span>
                </div>
              </div>
            ) : (
              <div className="inspector-grid" aria-label="File summary">
                <div className="inspector-cell">
                  <span className="cell-label">File</span>
                  <strong className="cell-value cell-truncate" title={node.label}>{node.label}</strong>
                </div>
                <div className="inspector-cell">
                  <span className="cell-label">Dependencies</span>
                  <span className="cell-value cell-count">{outgoing.length}</span>
                </div>
                <div className="inspector-cell inspector-cell-path">
                  <span className="cell-label">Location</span>
                  <code className="cell-value cell-path" title={node.detail}>{node.detail}</code>
                </div>
                <div className="inspector-cell">
                  <span className="cell-label">Dependents</span>
                  <span className="cell-value cell-count">{incoming.length}</span>
                </div>
              </div>
            )}

            <div className="inspector-meta">
              {node.callable ? (
                <>
                  <span className="muted">{Object.hasOwn(kindLabels, node.callable.kind) ? kindLabels[node.callable.kind] : 'Callable'}</span>
                  {node.language && <span className="muted">{languageName[node.language]}</span>}
                  {canOpenFile(node.file) && <button type="button" className="primary-button" onClick={() => onFile(node.file)}>Open declaration file</button>}
                </>
              ) : (
                <>
                  {node.language && <span className="muted">{languageName[node.language]}{node.package ? ' package' : ''}</span>}
                  {node.cycle && <span className="cycle-note">Circular dependency</span>}
                  {canExplore && !node.package && <button type="button" className="primary-button" onClick={() => onFunctions(node.file)}>Explore functions</button>}
                </>
              )}
            </div>

            <Section title={functions ? 'Direct callees' : 'Direct dependencies'}>
              <Relations edges={outgoing} index={index} view={view} onFocus={onFocus} onEdge={onEdge} />
            </Section>
            <Section title={functions ? 'Direct callers' : 'Direct dependents'}>
              <Relations edges={incoming} index={index} view={view} onFocus={onFocus} onEdge={onEdge} incoming />
            </Section>
            {moduleCalls.length > 0 && (
              <details className="inspector-details">
                <summary>Module initialization calls ({moduleCalls.length})</summary>
                <ul className="evidence-list">
                  {moduleCalls.map((call, i) => (
                    <li key={i}>
                      <strong>{callableIndex.byId.get(call.callee)?.label}</strong>
                      <Location range={call.at} />
                      <small>Target declaration</small><Location range={call.target} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {functions && unresolved.length > 0 && (
              <details className="inspector-details">
                <summary>Unresolved and ambiguous calls ({unresolved.length})</summary>
                <ul className="evidence-list">
                  {unresolved.map((call, i) => (
                    <li key={i}>
                      <strong>{call.status === 'ambiguous' ? 'Ambiguous' : 'Unresolved'}</strong>
                      <Location range={call.at} /><p>{call.reason}</p>
                      {call.candidates?.some(id => index.byId.has(id)) && <small>
                        Possible targets · {call.candidates.flatMap(id => {
                          const candidate = index.byId.get(id);
                          return candidate ? [candidate.label + ' · ' + candidate.detail] : [];
                        }).join(', ')}
                      </small>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
        {edge && from && to && (
          <>
            <div className="inspector-grid" aria-label="Edge summary">
              <Endpoint role={functions ? 'Caller' : 'Consumer'} node={from} onFocus={onFocus} />
              <Endpoint role={functions ? 'Callee' : 'Supplier'} node={to} onFocus={onFocus} />
            </div>
            {edge.cycle && <span className="cycle-note">Circular dependency</span>}
            {!edge.call && !!edge.evidence?.length && (
              <Section title={edge.dependency === 'include' ? 'Include sites' : edge.dependency === 'reference' ? 'Reference sites' : 'Import sites'}>
                <ul className="evidence-list">{edge.evidence.map((at, i) => <li key={i}><Location range={at} /></li>)}</ul>
              </Section>
            )}
            {edge.call ? (
              <Section title={edge.call.kind === 'construct' ? 'Constructor call sites' : 'Call sites'}>
                {edge.call.sites.length ? (
                  <ol className="evidence-list">
                    {edge.call.sites.map((site, i) => (
                      <li key={i}>
                        <strong>Call {i + 1}</strong><Location range={site.at} />
                        <small>Target declaration</small><Location range={site.target} />
                        {site.signature && <><small>Selected overload</small><Location range={site.signature} /></>}
                      </li>
                    ))}
                  </ol>
                ) : <><p className="muted">Call-site evidence unavailable.</p><Location range={to.callable?.declaration} /></>}
              </Section>
            ) : (
              <Section title="Symbol references">
                {edge.symbols?.length ? (
                  <ul className="evidence-list">
                    {edge.symbols.map((item, i) => (
                      <li key={i}>
                        <strong>{item.importedSymbol} <small>{item.typeOnly ? 'Type-only' : 'Value reference'}</small></strong>
                        <small>Scope · {item.usedInScope}</small>
                        <code>{item.usedInFile}:{item.line}</code>
                        {item.note && <p>{item.note}</p>}
                      </li>
                    ))}
                  </ul>
                ) : <p className="muted">No symbol references were recorded for this dependency.</p>}
              </Section>
            )}
            {!!callsForEdge.length && (
              <Section title="Resolved calls between files">
                <ul className="relation-list">
                  {callsForEdge.map(call => (
                    <li key={call.id}>
                      <button type="button" className="node-link" onClick={() => onFunctions(from.file, call.id)}>
                        <strong>{callableIndex.byId.get(call.source)?.label} → {callableIndex.byId.get(call.target)?.label}</strong>
                        <small>{call.call?.sites.length ?? 0} call sites</small>
                      </button>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
