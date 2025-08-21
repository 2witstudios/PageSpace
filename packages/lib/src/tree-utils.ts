export function buildTree<T extends { id: string; parentId: string | null }>(nodes: T[]): (T & { children: T[] })[] {
    const nodeMap = new Map(nodes.map(node => [node.id, { ...node, children: [] as (T & { children: T[] })[] }]));
    const tree: (T & { children: T[] })[] = [];

    for (const node of nodes) {
        const nodeWithChildren = nodeMap.get(node.id)!;
        if (node.parentId && nodeMap.has(node.parentId)) {
            const parentNode = nodeMap.get(node.parentId)!;
            parentNode.children.push(nodeWithChildren);
        } else {
            tree.push(nodeWithChildren);
        }
    }

    return tree;
}