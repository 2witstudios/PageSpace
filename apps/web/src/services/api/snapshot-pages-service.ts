export interface SnapshotPageNode {
  pageId: string;
  title: string | null;
  type: string;
  parentId: string | null;
  position: number;
  isTrashed: boolean;
  stateHash: string | null;
  content?: string;
  children: SnapshotPageNode[];
}

type SnapshotPageRow = {
  pageId: string;
  title: string | null;
  type: string | null;
  parentId: string | null;
  position: number | null;
  isTrashed: boolean;
  stateHash: string | null;
  content?: string;
};

export function buildSnapshotPageTree(rows: SnapshotPageRow[]): SnapshotPageNode[] {
  const nodeMap = new Map<string, SnapshotPageNode>();

  for (const row of rows) {
    nodeMap.set(row.pageId, {
      pageId: row.pageId,
      title: row.title,
      type: row.type ?? 'document',
      parentId: row.parentId,
      position: row.position ?? 0,
      isTrashed: row.isTrashed,
      stateHash: row.stateHash,
      ...(row.content !== undefined ? { content: row.content } : {}),
      children: [],
    });
  }

  const roots: SnapshotPageNode[] = [];
  for (const node of nodeMap.values()) {
    if (node.parentId === null || !nodeMap.has(node.parentId)) {
      roots.push(node);
    } else {
      nodeMap.get(node.parentId)!.children.push(node);
    }
  }

  sortInPlace(roots);
  return roots;
}

function sortInPlace(nodes: SnapshotPageNode[]): void {
  nodes.sort((a, b) => a.position - b.position);
  for (const node of nodes) {
    sortInPlace(node.children);
  }
}

export function sortSnapshotNodes(nodes: SnapshotPageNode[]): SnapshotPageNode[] {
  return [...nodes]
    .sort((a, b) => a.position - b.position)
    .map(node => ({ ...node, children: sortSnapshotNodes(node.children) }));
}
