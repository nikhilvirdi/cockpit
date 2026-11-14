import ELK from 'elkjs/lib/elk-api.js';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';
import type { ElkExtendedEdge } from 'elkjs/lib/elk-api.js';
import type { Core, Position } from 'cytoscape';

export async function layoutGraph(cy: Core, signal: AbortSignal) {
  signal.throwIfAborted();
  const worker = new Worker(workerUrl);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    const elk = new ELK({ workerFactory: () => worker });
    const nodes = cy.nodes().map(node => ({ id: node.id(), width: node.outerWidth(), height: node.outerHeight() }));
    const edges = cy.edges().map<ElkExtendedEdge>(edge => ({ id: edge.id(), sources: [edge.source().id()], targets: [edge.target().id()] }));
    const layout = elk.layout({
      id: 'graph',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.edgeRouting': 'POLYLINE',
        'elk.spacing.nodeNode': '32',
        'elk.layered.spacing.nodeNodeBetweenLayers': '76',
        'elk.spacing.componentComponent': '52',
        'elk.aspectRatio': String(Math.max(1, Math.min(2, cy.width() / Math.max(cy.height(), 1)))),
      },
      children: nodes,
      edges,
    });
    const result = await Promise.race([
      layout,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        worker.onerror = () => reject(new Error('The layout worker failed.'));
        timer = setTimeout(() => reject(new Error('The layout worker timed out.')), 8000);
      }),
    ]);
    const positions = new Map<string, Position>();
    for (const node of result.children ?? []) {
      if (typeof node.x !== 'number' || typeof node.y !== 'number' || !Number.isFinite(node.x) || !Number.isFinite(node.y)) {
        throw new Error('The layout returned invalid positions.');
      }
      positions.set(node.id, { x: node.x + node.width / 2, y: node.y + node.height / 2 });
    }
    if (positions.size !== nodes.length) throw new Error('The layout omitted nodes.');
    return { positions, routes: result.edges ?? [] };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    worker.onerror = null;
    worker.terminate();
  }
}
