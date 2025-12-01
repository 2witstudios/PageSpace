export type TreeNode<T> = T & { children: TreeNode<T>[] };

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

/**
 * Icons for each page type used in markdown tree output
 */
const PAGE_TYPE_ICONS: Record<string, string> = {
  FOLDER: '📁',
  DOCUMENT: '📄',
  AI_CHAT: '🤖',
  CHANNEL: '💬',
  CANVAS: '🎨',
  SHEET: '📊',
  FILE: '📎',
  TASK_LIST: '✅',
};

/**
 * Options for formatting tree as markdown
 */
export interface FormatTreeOptions {
  maxNodes?: number;      // Maximum nodes to include (default: 200)
  showIcons?: boolean;    // Whether to show type icons (default: true)
}

/**
 * Calculate the safe depth where total nodes don't exceed maxNodes.
 * Returns -1 if even depth 0 exceeds the limit.
 */
export function calculateSafeDepth<T extends { children: T[] }>(
  tree: T[],
  maxNodes: number
): { safeDepth: number; totalNodes: number; hiddenNodes: number } {
  const countsByDepth: number[] = [];

  function countAtDepth(nodes: T[], depth: number): void {
    countsByDepth[depth] = (countsByDepth[depth] || 0) + nodes.length;
    for (const node of nodes) {
      if (node.children && node.children.length > 0) {
        countAtDepth(node.children, depth + 1);
      }
    }
  }

  countAtDepth(tree, 0);

  let total = 0;
  let safeDepth = countsByDepth.length; // No truncation needed by default

  for (let d = 0; d < countsByDepth.length; d++) {
    if (total + countsByDepth[d] > maxNodes) {
      safeDepth = d > 0 ? d - 1 : 0;
      break;
    }
    total += countsByDepth[d];
  }

  const totalNodes = countsByDepth.reduce((sum, c) => sum + c, 0);
  const shownNodes = countsByDepth.slice(0, safeDepth + 1).reduce((sum, c) => sum + c, 0);
  const hiddenNodes = totalNodes - shownNodes;

  return { safeDepth, totalNodes, hiddenNodes };
}

/**
 * Format a tree structure as a markdown tree with visual connectors.
 *
 * Output format:
 * ```
 * ├── 📁 Projects
 * │   ├── 📄 Research Notes
 * │   └── 🤖 AI Assistant
 * └── 📁 Archive
 * ```
 */
export function formatTreeAsMarkdown<T extends { id: string; title: string; type: string; children: T[] }>(
  tree: T[],
  options: FormatTreeOptions = {}
): string {
  const { maxNodes = 200, showIcons = true } = options;

  if (tree.length === 0) {
    return '(empty)';
  }

  // Calculate safe depth for truncation
  const { safeDepth, hiddenNodes } = calculateSafeDepth(tree, maxNodes);

  const lines: string[] = [];

  function formatNode(node: T, prefix: string, isLast: boolean, depth: number): void {
    // Skip if we're past the safe depth
    if (depth > safeDepth) return;

    const icon = showIcons ? (PAGE_TYPE_ICONS[node.type] || '📄') + ' ' : '';
    const connector = isLast ? '└── ' : '├── ';
    lines.push(prefix + connector + icon + node.title + ` (id: ${node.id})`);

    if (node.children && node.children.length > 0 && depth < safeDepth) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      node.children.forEach((child, index) => {
        formatNode(child, childPrefix, index === node.children.length - 1, depth + 1);
      });
    }
  }

  tree.forEach((root, index) => {
    formatNode(root, '', index === tree.length - 1, 0);
  });

  // Add truncation indicator if needed
  if (hiddenNodes > 0) {
    lines.push(`\n[...deeper levels hidden (${hiddenNodes} more pages)]`);
  }

  return lines.join('\n');
}

/**
 * Filter a flat list of nodes to only include a subtree rooted at the given pageId.
 * Returns nodes that are the root or descendants of the root.
 */
export function filterToSubtree<T extends { id: string; parentId: string | null }>(
  nodes: T[],
  rootPageId: string
): T[] {
  // Build set of all descendant IDs including the root
  const descendantIds = new Set<string>([rootPageId]);
  let added = true;

  // Keep iterating until no new descendants are found
  while (added) {
    added = false;
    for (const node of nodes) {
      if (node.parentId && descendantIds.has(node.parentId) && !descendantIds.has(node.id)) {
        descendantIds.add(node.id);
        added = true;
      }
    }
  }

  return nodes.filter(n => descendantIds.has(n.id));
}
