import { useEffect, useEffectEvent, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import type { Core, ElementDefinition, EventObject, Position, StylesheetJson } from 'cytoscape';
import type { RefObject } from 'react';
import type { Selection } from '../types';
import type { ViewEdge, ViewNode } from '../graphView';
import { basename } from '../graphView';
import { layoutGraph } from '../graphLayout';

const nodeWidth = 174;
const nodeHeight = 54;
const padding = 28;

const styles: StylesheetJson = [
  { selector: 'node', style: {
    label: 'data(label)', shape: 'round-rectangle', width: nodeWidth, height: nodeHeight,
    'background-color': '#161616', 'border-width': 1, 'border-color': '#555555',
    color: '#f0f0f0', 'font-family': 'Nunito, sans-serif', 'font-size': 12,
    'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap',
    'text-max-width': (nodeWidth - 16) + 'px', 'text-overflow-wrap': 'anywhere',
  } },
  { selector: 'edge', style: {
    width: 1.5, 'line-color': '#aaaab1', 'target-arrow-color': '#aaaab1',
    'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'arrow-scale': 1.2,
    'loop-direction': '0deg', 'loop-sweep': '64deg',
  } },
  { selector: 'edge[?loop]', style: { 'control-point-step-size': 70 } },
  { selector: 'edge.symbol-edge', style: { 'line-color': '#58a6ff', 'target-arrow-color': '#58a6ff' } },
  { selector: 'edge.type-edge', style: { 'line-style': 'dashed' } },
  { selector: 'node.dependency', style: { 'border-color': '#58a6ff', 'border-width': 2 } },
  { selector: 'node.dependent', style: { 'border-color': '#e2ab60', 'border-width': 2 } },
  { selector: 'node.dependent.dependency', style: { 'border-color': '#b39bfb', 'border-width': 2 } },
  { selector: 'edge.dependency', style: { 'line-color': '#58a6ff', 'target-arrow-color': '#58a6ff', width: 2.2 } },
  { selector: 'edge.dependent', style: { 'line-color': '#e2ab60', 'target-arrow-color': '#e2ab60', width: 2.2 } },
  { selector: 'node.cycle', style: { 'border-color': '#f85149', 'border-width': 2 } },
  { selector: 'edge.cycle', style: { 'line-color': '#f85149', 'target-arrow-color': '#f85149', 'line-style': 'dashed' } },
  { selector: 'node.active, node.hover', style: { 'background-color': '#272b31', 'border-width': 3 } },
  { selector: 'node.active', style: { 'underlay-color': '#eeeeee', 'underlay-opacity': 0.75, 'underlay-padding': 4, 'underlay-shape': 'round-rectangle' } },
  { selector: 'edge.active, edge.hover', style: { width: 3.5, 'z-index': 10 } },
  { selector: '.dimmed', style: { opacity: 0.24 } },
];

interface Props {
  cyRef: RefObject<Core | null>;
  nodes: ViewNode[];
  edges: ViewEdge[];
  selection: Selection;
  viewKey: string;
  onSelect: (selection: Selection) => void;
}

const nodeId = (id: string) => 'node:' + id;
const edgeId = (id: string) => 'edge:' + id;
type Viewport = { zoom: number; pan: Position; ids: Set<string> };

function sameElements(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...left].every(id => right.has(id));
}

function label(node: ViewNode) {
  const name = node.label.length > 31 ? node.label.slice(0, 13) + '…' + node.label.slice(-17) : node.label;
  if (!node.callable) return name;
  const file = node.context ?? basename(node.file);
  const line = node.callable.declaration;
  return name + '\n' + (file.length > 19 ? file.slice(0, 7) + '…' + file.slice(-11) : file)
    + (line ? ':' + (line.startLine + 1) + ':' + (line.startColumn + 1) : '');
}

function highlight(cy: Core, selection: Selection, center = true) {
  cy.batch(() => {
    const elements = cy.elements();
    elements.removeClass('active dependency dependent dimmed');
    if (!selection) return;
    if (selection.kind === 'edge') {
      const edge = cy.getElementById(edgeId(selection.id));
      if (edge.empty()) return;
      const endpoints = edge.connectedNodes();
      elements.not(edge.union(endpoints)).addClass('dimmed');
      edge.addClass('active');
      endpoints.addClass('active');
      if (center) cy.center(endpoints);
    } else {
      const node = cy.getElementById(nodeId(selection.id));
      if (node.empty()) return;
      const outgoing = node.outgoers('edge');
      const incoming = node.incomers('edge');
      const edges = outgoing.union(incoming);
      elements.not(node.union(edges).union(edges.connectedNodes())).addClass('dimmed');
      outgoing.union(outgoing.targets().not(node)).addClass('dependency');
      incoming.union(incoming.sources().not(node)).addClass('dependent');
      node.addClass('active');
      if (center) cy.center(node);
    }
  });
}

function fit(cy: Core) {
  cy.fit(undefined, padding);
  if (cy.zoom() > 1.15) cy.zoom({ level: 1.15, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
}

export default function GraphCanvas({ cyRef, nodes, edges, selection, viewKey, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const drawn = useRef({ viewKey: '', ids: new Set<string>(), pending: false });
  const viewports = useRef(new Map<string, Viewport>());
  const [status, setStatus] = useState('');
  const choose = useEffectEvent(onSelect);
  const highlightSelection = useEffectEvent((cy: Core, center: boolean) => highlight(cy, selection, center));

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const savedViewports = viewports.current;
    let cy: Core;
    try {
      cy = cytoscape({ container, style: styles, layout: { name: 'preset' }, minZoom: 0.035, maxZoom: 3,
        autoungrabify: true, autounselectify: true, boxSelectionEnabled: false });
    } catch (error) {
      queueMicrotask(() => setStatus('The graph renderer could not start. Use search and the inspector to explore.'));
      console.error('Cockpit renderer initialization failed', error);
      return;
    }
    cyRef.current = cy;
    const tap = (event: EventObject) => {
      if (event.target === cy) choose(null);
      else choose({ kind: event.target.isNode() ? 'node' : 'edge', id: event.target.data('canonicalId') });
    };
    const mouseOver = (event: EventObject) => {
      event.target.addClass('hover');
      container.style.cursor = 'pointer';
    };
    const mouseOut = (event: EventObject) => {
      event.target.removeClass('hover');
      container.style.cursor = '';
    };
    cy.on('tap', tap);
    cy.on('mouseover', 'node, edge', mouseOver);
    cy.on('mouseout', 'node, edge', mouseOut);
    const resize = new ResizeObserver(() => {
      const width = cy.width(), height = cy.height();
      cy.resize();
      if (width !== cy.width() || height !== cy.height()) {
        const pan = cy.pan();
        cy.pan({ x: pan.x + (cy.width() - width) / 2, y: pan.y + (cy.height() - height) / 2 });
      }
    });
    resize.observe(container);
    return () => {
      resize.disconnect();
      cy.off('tap', tap);
      cy.off('mouseover', 'node, edge', mouseOver);
      cy.off('mouseout', 'node, edge', mouseOut);
      cy.destroy();
      cyRef.current = null;
      drawn.current = { viewKey: '', ids: new Set(), pending: false };
      savedViewports.clear();
    };
  }, [cyRef]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const previous = drawn.current;
    const sameView = previous.viewKey === viewKey;
    if (!sameView) {
      const revision = viewKey.split(':')[0];
      if (previous.viewKey.startsWith(revision + ':') && !previous.pending && previous.ids.size) {
        viewports.current.set(previous.viewKey, { zoom: cy.zoom(), pan: { ...cy.pan() }, ids: previous.ids });
      } else if (!previous.viewKey.startsWith(revision + ':')) viewports.current.clear();
    }
    const definitions: ElementDefinition[] = [
      ...nodes.map(node => ({
        group: 'nodes' as const, data: { id: nodeId(node.id), canonicalId: node.id, label: label(node) },
        classes: node.cycle ? 'cycle' : '',
      })),
      ...edges.map(edge => ({
        group: 'edges' as const, data: {
          id: edgeId(edge.id), canonicalId: edge.id, source: nodeId(edge.source), target: nodeId(edge.target),
          loop: edge.source === edge.target,
        },
        classes: edge.cycle ? 'cycle' : edge.symbols?.some(item => !item.typeOnly) ? 'symbol-edge'
          : edge.symbols?.length ? 'type-edge' : '',
      })),
    ];
    const ids = new Set(definitions.map(element => element.data.id!));
    if (!previous.pending && sameView && sameElements(ids, previous.ids)) return;

    const controller = new AbortController();
    const oldPositions = new Map(cy.nodes().map(node => [node.id(), node.position()]));
    const focus = cy.nodes('.active').first();
    const anchorId = focus.id();
    const anchor = oldPositions.get(anchorId);
    cy.batch(() => {
      cy.elements().filter(element => !sameView || !ids.has(element.id())).remove();
      cy.add(definitions.filter(element => cy.getElementById(element.data.id!).empty()));
      if (!sameView || !previous.ids.size) cy.layout({ name: 'grid', fit: false, avoidOverlap: true, spacingFactor: 1.25 }).run();
    });
    drawn.current = { viewKey, ids, pending: nodes.length > 0 };
    highlightSelection(cy, false);
    if (!nodes.length) {
      queueMicrotask(() => { if (!controller.signal.aborted) setStatus(''); });
      return () => controller.abort();
    }
    queueMicrotask(() => { if (!controller.signal.aborted) setStatus('Arranging graph…'); });

    void layoutGraph(cy, controller.signal).then(({ positions, routes }) => {
      if (controller.signal.aborted || cy.destroyed()) return;
      const newAnchor = positions.get(anchorId);
      const offset: Position = sameView && anchor && newAnchor
        ? { x: anchor.x - newAnchor.x, y: anchor.y - newAnchor.y } : { x: 0, y: 0 };
      cy.batch(() => {
        cy.nodes().positions(node => {
          const point = positions.get(node.id())!;
          return { x: point.x + offset.x, y: point.y + offset.y };
        });
        cy.edges().removeStyle('curve-style edge-distances segment-weights segment-distances');
        for (const route of routes) {
          const edge = cy.getElementById(route.id);
          const section = route.sections?.[0];
          const start = positions.get(route.sources[0]);
          const end = positions.get(route.targets[0]);
          if (edge.empty() || !section?.bendPoints?.length || !start || !end || edge.isLoop()) continue;
          const dx = end.x - start.x, dy = end.y - start.y;
          const length = Math.hypot(dx, dy);
          if (!length) continue;
          const weights = section.bendPoints.map(point => ((point.x - start.x) * dx + (point.y - start.y) * dy) / length ** 2);
          const distances = section.bendPoints.map(point => ((point.y - start.y) * dx - (point.x - start.x) * dy) / length);
          edge.style({ 'curve-style': 'segments', 'edge-distances': 'node-position',
            'segment-weights': weights.join(' '), 'segment-distances': distances.join(' ') });
        }
      });
      drawn.current.pending = false;
      const saved = !sameView && viewports.current.get(viewKey);
      const restored = saved && sameElements(ids, saved.ids);
      if (restored) cy.viewport({ zoom: saved.zoom, pan: saved.pan });
      else if (!sameView || !anchor || !cy.getElementById(anchorId).length) fit(cy);
      highlightSelection(cy, !restored);
      setStatus('');
    }).catch(error => {
      if (controller.signal.aborted || cy.destroyed()) return;
      console.error('Cockpit graph layout failed', error);
      cy.edges().removeStyle('curve-style edge-distances segment-weights segment-distances');
      cy.layout({ name: 'grid', fit: false, avoidOverlap: true, spacingFactor: 1.25 }).run();
      fit(cy);
      drawn.current.pending = false;
      highlightSelection(cy, true);
      setStatus('Layered layout unavailable. Showing a grid.');
    });

    return () => controller.abort();
  }, [cyRef, edges, nodes, viewKey]);

  useEffect(() => {
    const cy = cyRef.current;
    if (cy) highlight(cy, selection, !drawn.current.pending);
  }, [cyRef, selection]);

  return (
    <div className="graph-canvas-container">
      <div ref={containerRef} className="graph-surface" aria-hidden="true" />
      {status && <span className="layout-status" role="status">{status}</span>}
    </div>
  );
}
