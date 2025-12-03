import { TreePage } from "@/hooks/usePageTree";

export function findNodeAndParent(
  tree: TreePage[],
  nodeId: string,
  parent: TreePage | null = null
): { node: TreePage; parent: TreePage | null } | null {
  for (const node of tree) {
    if (node.id === nodeId) {
      return { node, parent };
    }
    if (node.children) {
      const found = findNodeAndParent(node.children, nodeId, node);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

export function removeNode(tree: TreePage[], nodeId: string): TreePage[] {
  return tree.filter(node => {
    if (node.id === nodeId) {
      return false;
    }
    if (node.children) {
      node.children = removeNode(node.children, nodeId);
    }
    return true;
  });
}

export function addNode(
  tree: TreePage[],
  nodeToAdd: TreePage,
  parentId: string | null,
  index: number
): TreePage[] {
  if (parentId === null) {
    const newTree = [...tree];
    newTree.splice(index, 0, nodeToAdd);
    return newTree;
  }

  return tree.map(node => {
    if (node.id === parentId) {
      const newChildren = [...(node.children || [])];
      newChildren.splice(index, 0, nodeToAdd);
      return { ...node, children: newChildren };
    }
    if (node.children) {
      return { ...node, children: addNode(node.children, nodeToAdd, parentId, index) };
    }
    return node;
  });
}
export function mergeChildren(
  tree: TreePage[],
  parentId: string,
  children: TreePage[]
): TreePage[] {
  return tree.map(node => {
    if (node.id === parentId) {
      // It's crucial to ensure the new children also have a `children` array property
      const newChildren = children.map(c => ({ ...c, children: c.children || [] }));
      // Sort by position to ensure consistent ordering
      newChildren.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      return { ...node, children: newChildren };
    }
    if (node.children && node.children.length > 0) {
      return { ...node, children: mergeChildren(node.children, parentId, children) };
    }
    return node;
  });
}


export function buildTree<T extends { id: string; parentId: string | null; position?: number }>(nodes: T[]): (T & { children: (T & { children: T[] })[] })[] {
    type NodeWithChildren = T & { children: NodeWithChildren[] };
    const nodeMap = new Map(nodes.map(node => [node.id, { ...node, children: [] as NodeWithChildren[] }]));
    const tree: NodeWithChildren[] = [];

    for (const node of nodes) {
        const nodeWithChildren = nodeMap.get(node.id)!;
        if (node.parentId && nodeMap.has(node.parentId)) {
            const parentNode = nodeMap.get(node.parentId)!;
            parentNode.children.push(nodeWithChildren);
        } else {
            tree.push(nodeWithChildren);
        }
    }

    // Sort all children arrays by position to ensure consistent ordering
    function sortByPosition(nodes: NodeWithChildren[]): void {
        nodes.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        for (const node of nodes) {
            if (node.children.length > 0) {
                sortByPosition(node.children);
            }
        }
    }

    sortByPosition(tree);

    return tree;
}

/**
 * Build the full path from root to a specific page for AI context
 * Returns both the path and parent information
 */
export function buildPagePath(
  tree: TreePage[],
  nodeId: string,
  driveId: string
): {
  path: string;
  parentPath: string;
  breadcrumbs: string[];
} | null {
  function findPath(nodes: TreePage[], targetId: string, currentPath: string[] = []): string[] | null {
    for (const node of nodes) {
      const newPath = [...currentPath, node.title];
      
      if (node.id === targetId) {
        return newPath;
      }
      
      if (node.children && node.children.length > 0) {
        const found = findPath(node.children, targetId, newPath);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  const breadcrumbs = findPath(tree, nodeId);
  if (!breadcrumbs) {
    return null;
  }

  const path = `/${driveId}/${breadcrumbs.join('/')}`;
  const parentPath = breadcrumbs.length > 1
    ? `/${driveId}/${breadcrumbs.slice(0, -1).join('/')}`
    : `/${driveId}`;

  return {
    path,
    parentPath,
    breadcrumbs: [driveId, ...breadcrumbs]
  };
}