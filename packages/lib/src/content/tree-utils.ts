type TreeNode<T> = T & { children: TreeNode<T>[] };

export function buildTree<T extends { id: string; parentId: string | null }>(nodes: T[]): TreeNode<T>[] {
    // Deduplicate nodes by ID - last occurrence wins
    const nodeMap = new Map<string, T>();
    for (const node of nodes) {
        nodeMap.set(node.id, node);
    }

    // Build tree from unique nodes
    const nodeWithChildrenMap = new Map<string, TreeNode<T>>();
    for (const node of nodeMap.values()) {
        nodeWithChildrenMap.set(node.id, { ...node, children: [] });
    }

    const tree: TreeNode<T>[] = [];

    for (const node of nodeMap.values()) {
        const nodeWithChildren = nodeWithChildrenMap.get(node.id)!;
        if (node.parentId && nodeWithChildrenMap.has(node.parentId)) {
            const parentNode = nodeWithChildrenMap.get(node.parentId)!;
            parentNode.children.push(nodeWithChildren);
        } else {
            tree.push(nodeWithChildren);
        }
    }

    return tree;
}