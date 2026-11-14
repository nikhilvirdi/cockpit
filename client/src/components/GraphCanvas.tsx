import { useEffect, useRef } from 'react';
import cytoscape from 'cytoscape';
import type { Core, EventObject } from 'cytoscape';
import type {
  GraphData,
  SelectedNodeInfo,
  SelectedEdgeInfo,
  SymbolUsageItem,
} from '../types';

interface GraphCanvasProps {
  graphData: GraphData;
  cycleNodesSet: Set<string>;
  cycleEdgesSet: Set<string>;
  incomingMap: Map<string, string[]>;
  outgoingMap: Map<string, string[]>;
  symbolUsageByEdgeMap: Map<string, SymbolUsageItem[]>;
  onSelectNode: (info: SelectedNodeInfo) => void;
  onSelectEdge: (info: SelectedEdgeInfo) => void;
  onDeselect: () => void;
  // expose cy ref so parent can call focusNodeInGraph / selectEdgeByKey
  cyRef: React.MutableRefObject<Core | null>;
}

/**
 * Post-layout pass that checks bounding-box intersection using each node's
 * current dynamic width/height and repeatedly nudges overlapping pairs apart
 * until zero overlap remains.
 */
function enforceZeroOverlap(cyInstance: Core) {
  const nodes = cyInstance.nodes().toArray();
  if (nodes.length <= 1) return;

  const PADDING = 20; // visual buffer between node bounding boxes
  const MAX_ITERATIONS = 120;

  // Pre-calculate effective dynamic dimensions and current positions
  const nodeData = nodes.map((n: any) => {
    const label = n.data('label') || '';
    const dynW = Math.max(190, Math.min(280, label.length * 10 + 40));
    const lines = Math.ceil((label.length * 9.5) / 240);
    const dynH = Math.max(50, Math.min(84, 34 + lines * 18));

    const w = Math.max(n.outerWidth() || 0, dynW) + PADDING;
    const h = Math.max(n.outerHeight() || 0, dynH) + PADDING;
    const pos = { ...n.position() };

    return {
      node: n,
      w,
      h,
      pos,
    };
  });

  let iteration = 0;
  let hadOverlap = true;

  while (hadOverlap && iteration < MAX_ITERATIONS) {
    hadOverlap = false;
    iteration++;

    for (let i = 0; i < nodeData.length; i++) {
      const a = nodeData[i];
      for (let j = i + 1; j < nodeData.length; j++) {
        const b = nodeData[j];

        const dx = a.pos.x - b.pos.x;
        const dy = a.pos.y - b.pos.y;
        const overlapX = (a.w + b.w) / 2 - Math.abs(dx);
        const overlapY = (a.h + b.h) / 2 - Math.abs(dy);

        if (overlapX > 0 && overlapY > 0) {
          hadOverlap = true;

          // Nudge apart along minimum penetration axis
          if (overlapX < overlapY) {
            const shift = (overlapX / 2) + 2;
            const sign = dx >= 0 ? 1 : -1;
            a.pos.x += shift * sign;
            b.pos.x -= shift * sign;
          } else {
            const shift = (overlapY / 2) + 2;
            const sign = dy >= 0 ? 1 : -1;
            a.pos.y += shift * sign;
            b.pos.y -= shift * sign;
          }
        }
      }
    }
  }

  // Batch update all node positions in Cytoscape
  cyInstance.batch(() => {
    for (const item of nodeData) {
      item.node.position(item.pos);
    }
  });
}

export default function GraphCanvas({
  graphData,
  cycleNodesSet,
  cycleEdgesSet,
  incomingMap,
  outgoingMap,
  symbolUsageByEdgeMap,
  onSelectNode,
  onSelectEdge,
  onDeselect,
  cyRef,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const elements: cytoscape.ElementDefinition[] = [];

    // Build Nodes
    for (const node of graphData.nodes || []) {
      const isCycle = cycleNodesSet.has(node.id);
      const label = node.id.split('/').pop() || node.id;

      elements.push({
        group: 'nodes',
        data: {
          id: node.id,
          label,
          fullPath: node.path,
          isCycle,
          incoming: incomingMap.get(node.id) || [],
          outgoing: outgoingMap.get(node.id) || [],
        },
        classes: isCycle ? 'cycle-node' : '',
      });
    }

    // Build edges
    for (const edge of graphData.edges || []) {
      const edgeKey = `${edge.from}->${edge.to}`;
      const isCycle = cycleEdgesSet.has(edgeKey);
      const symbols = symbolUsageByEdgeMap.get(edgeKey) || [];
      let edgeClass = 'untraced-edge';
      if (isCycle) {
        edgeClass = 'cycle-edge';
      } else if (symbols.some(s => !s.typeOnly)) {
        edgeClass = 'symbol-usage-edge';
      } else if (symbols.length > 0) {
        edgeClass = 'type-only-edge';
      }

      elements.push({
        group: 'edges',
        data: {
          id: edgeKey,
          source: edge.from,
          target: edge.to,
          isCycle,
        },
        classes: edgeClass,
      });
    }

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        // ── 3. Standard File Node: rounded rect, 6px radius, 1px solid var(--node-border), bg var(--node-bg), min-w 190px max-w 280px
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            'background-color': '#161616', // var(--node-bg)
            color: '#f0f0f0', // var(--text-primary)
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': '15px',
            'font-weight': 500,
            'font-family': 'Nunito, -apple-system, BlinkMacSystemFont, sans-serif',
            width: (node: any): any => {
              const label = node.data('label') || '';
              return Math.max(190, Math.min(280, label.length * 10 + 40));
            },
            height: (node: any): any => {
              const label = node.data('label') || '';
              const lines = Math.ceil((label.length * 9.5) / 240);
              return Math.max(50, Math.min(84, 34 + lines * 18));
            },
            padding: '16px',
            shape: 'round-rectangle',
            'corner-radius': '6px',
            'border-width': 1,
            'border-color': '#ffffff', // var(--node-border)
            'border-opacity': 1,
            'text-wrap': 'wrap',
            'text-max-width': (node: any): any => {
              const label = node.data('label') || '';
              return Math.max(190, Math.min(280, label.length * 10 + 40)) - 32;
            },
            'transition-property': 'opacity, border-color, width, height',
            'transition-duration': 0.3,
            'transition-timing-function': 'ease-out',
          },
        },
        // ── Cycle Node
        {
          selector: 'node.cycle-node',
          style: {
            shape: 'round-rectangle',
            'corner-radius': '6px',
            'background-color': '#161616',
            'border-color': '#f85149', // var(--accent-error)
            'border-width': 1,
            'border-opacity': 1,
            color: '#f85149',
            'font-weight': 600,
            'font-family': 'Nunito, -apple-system, BlinkMacSystemFont, sans-serif',
          },
        },
        // ── 5. Hover/Focus Interaction States
        // Focused node gets border-color var(--connector-active) + box-shadow 0 0 0 1px var(--connector-active)
        {
          selector: 'node.focused, node:selected',
          style: {
            'border-width': 1,
            'border-color': '#a0a0a0', // var(--connector-active)
            'border-opacity': 1,
            'underlay-color': '#a0a0a0',
            'underlay-padding': 1,
            'underlay-opacity': 0.8,
            'underlay-shape': 'round-rectangle',
            'z-index': 99,
          },
        },
        // Direct neighbors of focused node get border-color var(--accent-primary) + matching box-shadow
        {
          selector: 'node.neighbor, node.highlighted-connection',
          style: {
            'border-width': 1,
            'border-color': '#a0a0a0', // var(--accent-primary)
            'border-opacity': 1,
            'underlay-color': '#a0a0a0',
            'underlay-padding': 1,
            'underlay-opacity': 0.5,
            'underlay-shape': 'round-rectangle',
            'z-index': 95,
          },
        },
        // Search match
        {
          selector: 'node.search-match',
          style: {
            'border-width': 1,
            'border-color': '#58a6ff', // var(--accent-info)
            'border-opacity': 1,
            'underlay-color': '#58a6ff',
            'underlay-padding': 1,
            'underlay-opacity': 0.6,
            'z-index': 85,
          },
        },
        // Dimmed nodes (opacity 0.3)
        { selector: 'node.dimmed', style: { opacity: 0.3 } },

        // Dependency edge styles
        // Base edge settings (all arrowheads: solid triangle matching edge stroke color)
        {
          selector: 'edge',
          style: {
            width: 1.5,
            'line-color': '#ffffff', // var(--connector-line)
            'target-arrow-color': '#ffffff',
            'target-arrow-shape': 'triangle',
            'target-arrow-fill': 'filled',
            'curve-style': 'bezier',
            'arrow-scale': 1.1,
            opacity: 1,
            'underlay-opacity': 0,
            'transition-property': 'opacity, line-color, target-arrow-color, width',
            'transition-duration': 0.3,
            'transition-timing-function': 'ease-out',
          },
        },
        // Symbol-usage edges: solid, 1.5px, var(--accent-info) [#58a6ff]
        {
          selector: 'edge.symbol-usage-edge',
          style: {
            width: 1.5,
            'line-color': '#58a6ff',
            'target-arrow-color': '#58a6ff',
            'line-style': 'solid',
            opacity: 1,
            'z-index': 4,
          },
        },
        // Cycle edges: dashed '6 4', 1.5px, var(--accent-error) [#f85149]
        {
          selector: 'edge.cycle-edge',
          style: {
            width: 1.5,
            'line-color': '#f85149',
            'target-arrow-color': '#f85149',
            'line-style': 'dashed',
            'line-dash-pattern': [6, 4],
            opacity: 1,
            'z-index': 10,
          },
        },
        // Type-only / untraced edges: dashed '6 4', 1.5px, var(--text-muted) [#8a8a8a]
        {
          selector: 'edge.type-only-edge, edge.untraced-edge',
          style: {
            width: 1.5,
            'line-color': '#8a8a8a',
            'target-arrow-color': '#8a8a8a',
            'line-style': 'dashed',
            'line-dash-pattern': [6, 4],
            opacity: 1,
            'z-index': 2,
          },
        },
        // Selected / Highlighted Edges
        {
          selector: 'edge:selected, edge.highlighted-edge',
          style: {
            width: 2,
            opacity: 1,
            'z-index': 99,
          },
        },
        // Dimmed edges (opacity 0.3)
        { selector: 'edge.dimmed', style: { opacity: 0.3 } },
      ],
      layout: { name: 'null' },
      minZoom: 0.2,
      maxZoom: 3,
    });

    cyRef.current = cy;
    (window as any).__cy = cy;

    // Run layout with avoidOverlap: true explicitly confirmed, followed by zero-overlap post-pass
    const layout = cy.layout({
      name: 'cose',
      animate: false,
      componentSpacing: 140,
      nodeOverlap: 40,
      nodeRepulsion: () => 900000,
      idealEdgeLength: () => 150,
      edgeElasticity: () => 100,
      nestingFactor: 5,
      gravity: 60,
      numIter: 1200,
      initialTemp: 200,
      coolingFactor: 0.95,
      minTemp: 1.0,
      avoidOverlap: true,
    });

    let hasEnforced = false;
    const runPostLayoutPass = () => {
      if (hasEnforced) return;
      hasEnforced = true;
      enforceZeroOverlap(cy);
      cy.fit(undefined, 40);
    };

    layout.one('layoutstop', runPostLayoutPass);
    layout.run();
    runPostLayoutPass();

    // Node tap handler
    cy.on('tap', 'node', (evt: EventObject) => {
      const node = evt.target as cytoscape.NodeSingular;
      const data = node.data() as SelectedNodeInfo;
      onSelectNode(data);

      cy.batch(() => {
        cy.elements().removeClass('dimmed highlighted-connection highlighted-edge focused neighbor');
        const outgoingEdges = node.outgoers('edge');
        const incomingEdges = node.incomers('edge');
        const directEdges = outgoingEdges.union(incomingEdges);
        const neighbors = directEdges.connectedNodes().not(node);

        // Full downstream dependency chain
        const successors = node.successors();
        const activeChain = node.union(successors);
        const activeEdges = activeChain.connectedEdges().filter((e: any) => {
          return activeChain.contains(e.source()) && activeChain.contains(e.target());
        });
        const allActiveEles = activeChain.union(activeEdges).union(neighbors).union(directEdges);

        // Dim unrelated nodes and edges to opacity 0.3
        cy.elements().not(allActiveEles).addClass('dimmed');
        node.addClass('focused');
        neighbors.addClass('neighbor');
        activeEdges.union(directEdges).addClass('highlighted-edge');
      });
    });

    // Edge tap
    cy.on('tap', 'edge', (evt: EventObject) => {
      const edge = evt.target as cytoscape.EdgeSingular;
      const data = edge.data();
      const edgeKey = `${data.source}->${data.target}`;
      const symbols = symbolUsageByEdgeMap.get(edgeKey) || [];

      onSelectEdge({
        id: edgeKey,
        source: data.source,
        target: data.target,
        isCycle: Boolean(data.isCycle),
        hasTracedSymbols: symbols.length > 0,
        symbolUsages: symbols,
      });
      cy.elements().removeClass('dimmed highlighted-connection highlighted-edge focused neighbor');
    });

    // Background tap (deselect)
    cy.on('tap', (evt: EventObject) => {
      if (evt.target === cy) {
        onDeselect();
        cy.elements().removeClass('dimmed highlighted-connection highlighted-edge focused neighbor');
      }
    });

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [graphData, cycleNodesSet, cycleEdgesSet, incomingMap, outgoingMap, symbolUsageByEdgeMap]);

  return (
    <div className="graph-canvas-container">
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
