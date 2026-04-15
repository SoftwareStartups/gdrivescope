import type { DriveGraph } from './model.js';

export function nodePath(graph: DriveGraph, id: string): string {
  if (!graph.hasNode(id)) return `<orphan>/${id}`;
  const parts: string[] = [];
  const guard = new Set<string>();
  let current: string | null = id;
  while (current && !guard.has(current)) {
    guard.add(current);
    const attrs = graph.getNodeAttributes(current);
    parts.unshift(attrs.name);
    const parent = attrs.parentId;
    if (!parent) break;
    if (!graph.hasNode(parent)) {
      parts.unshift('<orphan>');
      break;
    }
    current = parent;
  }
  return parts.join('/');
}

export function descendants(graph: DriveGraph, rootId: string): Set<string> {
  const out = new Set<string>();
  if (!graph.hasNode(rootId)) return out;
  const stack: string[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (out.has(id)) continue;
    out.add(id);
    for (const child of graph.outNeighbors(id)) {
      stack.push(child);
    }
  }
  out.delete(rootId);
  return out;
}
