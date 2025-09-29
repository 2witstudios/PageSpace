"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTree = buildTree;
function buildTree(nodes) {
    const nodeMap = new Map(nodes.map(node => [node.id, { ...node, children: [] }]));
    const tree = [];
    for (const node of nodes) {
        const nodeWithChildren = nodeMap.get(node.id);
        if (node.parentId && nodeMap.has(node.parentId)) {
            const parentNode = nodeMap.get(node.parentId);
            parentNode.children.push(nodeWithChildren);
        }
        else {
            tree.push(nodeWithChildren);
        }
    }
    return tree;
}
