import type { ReactNode } from 'react';
import type { FunctionGraph, Selection, SourceRange, View } from '../types';
import { location } from '../graphView';
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
    <div className="endpoint">
      <span className="field-label">{role}</span>
      <button type="button" className="node-link" onClick={() => onFocus(node.id)}>
        <strong>{node.label}</strong><small>{node.detail}</small>
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
  const title = node ? (functions ? 'Function inspector' : 'File inspector')
    : (functions ? 'Call inspector' : 'Dependency inspector');

  return (
    <aside className="dependency-inspector" aria-label={title}>
      <header className="inspector-header">
        <h2>{title}</h2>
        <button type="button" className="quiet-button" aria-label="Close inspector" onClick={onClose}>×</button>
      </header>
      <div className="inspector-body">
        {node && (
          <>
            <div className="inspector-identity">
              <h3>{node.label}</h3>
              {node.callable ? (
                <>
                  <span className="muted">{Object.hasOwn(kindLabels, node.callable.kind) ? kindLabels[node.callable.kind] : 'Callable'}</span>
                  <Location range={node.callable.declaration} />
                  {!node.callable.declaration && <code>{node.file}</code>}
                  {canOpenFile(node.file) && <button type="button" className="primary-button" onClick={() => onFile(node.file)}>Open declaration file</button>}
                </>
              ) : (
                <>
                  <code>{node.file}</code>
                  {node.cycle && <span className="cycle-note">Circular dependency</span>}
                  {canExplore && <button type="button" className="primary-button" onClick={() => onFunctions(node.file)}>Explore functions</button>}
                </>
              )}
            </div>
            <Section title={functions ? 'Direct callees' : 'Direct dependencies'}>
              <Relations edges={index.outgoing.get(node.id) ?? []} index={index} view={view} onFocus={onFocus} onEdge={onEdge} />
            </Section>
            <Section title={functions ? 'Direct callers' : 'Direct dependents'}>
              <Relations edges={index.incoming.get(node.id) ?? []} index={index} view={view} onFocus={onFocus} onEdge={onEdge} incoming />
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
            <div className="inspector-identity">
              <Endpoint role={functions ? 'Caller' : 'Consumer'} node={from} onFocus={onFocus} />
              <Endpoint role={functions ? 'Callee' : 'Supplier'} node={to} onFocus={onFocus} />
              {edge.cycle && <span className="cycle-note">Circular dependency</span>}
            </div>
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
