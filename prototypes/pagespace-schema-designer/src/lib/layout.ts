import dagre from "dagre";
import type { Edge, Node } from "@xyflow/react";

interface LayoutOptions {
  direction?: "LR" | "TB";
  nodeWidth?: number;
  rowHeight?: number;
  headerHeight?: number;
  rankSep?: number;
  nodeSep?: number;
}

export function layoutNodes<T extends { table: { columns: unknown[] }; collapsed: boolean }>(
  nodes: Node<T>[],
  edges: Edge[],
  opts: LayoutOptions = {},
): Node<T>[] {
  const {
    direction = "LR",
    nodeWidth = 260,
    rowHeight = 22,
    headerHeight = 46,
    rankSep = 160,
    nodeSep = 60,
  } = opts;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, ranksep: rankSep, nodesep: nodeSep, marginx: 40, marginy: 40 });

  for (const n of nodes) {
    const height = n.data.collapsed ? headerHeight : headerHeight + n.data.table.columns.length * rowHeight + 10;
    g.setNode(n.id, { width: nodeWidth, height });
  }

  for (const e of edges) {
    if (e.source !== e.target) g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      ...n,
      position: { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 },
    };
  });
}
