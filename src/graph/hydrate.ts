import { DirectedGraph } from 'graphology';
import type { DriveGraph, EdgeAttrs, Node } from './model.js';
import type { Store } from './store.js';

export function hydrateGraph(store: Store): DriveGraph {
  const graph: DriveGraph = new DirectedGraph<Node, EdgeAttrs>();
  const nodes = store.allNodes();
  for (const n of nodes) {
    graph.addNode(n.id, n);
  }
  for (const n of nodes) {
    if (n.parentId && graph.hasNode(n.parentId)) {
      graph.addEdge(n.parentId, n.id, {} as EdgeAttrs);
    }
  }
  return graph;
}
