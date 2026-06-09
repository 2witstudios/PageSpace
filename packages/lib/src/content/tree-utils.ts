export type TreeNode<T> = T & { children: TreeNode<T>[] };

export function buildTree<T extends { id: string; parentId: string | null; position?: number }>(nodes: T[]): TreeNode<T>[] {
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

    // Sort all children arrays by position to ensure consistent ordering
    function sortByPosition(nodes: TreeNode<T>[]): void {
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

/**
 * Filter a flat list of tree nodes down to those an actor may access.
 *
 * Security policy (ancestor-gated): a node is kept ONLY IF it is itself present
 * in `accessiblePageIds` AND every one of its ancestors that is present in
 * `nodes` is also accessible. Dropping an inaccessible node therefore also drops
 * its now-orphaned descendant subtree, even when those descendants are
 * individually in the accessible set.
 *
 * This deliberately avoids re-parenting an accessible descendant of an
 * inaccessible node to a fabricated root: doing so would alter the true
 * parent/child shape and could imply structure about (or the existence of) the
 * inaccessible ancestor. The result is always a sub-forest of the input, so
 * feeding it to `buildTree` reproduces the original shape minus the dropped
 * branches.
 *
 * Boundary handling matches `buildTree`: a node whose `parentId` is null, or
 * whose parent is absent from `nodes`, is treated as a root — only its own
 * accessibility is required at that point. A `parentId` cycle (which has no real
 * root) fails closed and drops the cycle's members.
 *
 * Visibility is memoized per node id, so each ancestor edge is traversed at most
 * once: the whole filter is O(n) regardless of tree depth (a deep, e.g.
 * API-created, chain does not degrade to O(n²)). The ancestor walk is iterative,
 * so depth cannot overflow the call stack.
 */
export function filterTreeNodesByAccess<T extends { id: string; parentId: string | null }>(
  nodes: T[],
  accessiblePageIds: ReadonlySet<string>
): T[] {
  const byId = new Map<string, T>();
  for (const node of nodes) {
    byId.set(node.id, node);
  }

  // id -> final visible/hidden decision (memo across all nodes).
  const visible = new Map<string, boolean>();

  function isVisible(start: T): boolean {
    // Walk up the ancestor chain, stacking accessible nodes whose visibility is
    // not yet known, until we hit a resolved boundary. Then propagate that
    // boundary result back down to every stacked node in one pass.
    const pending: T[] = [];
    const onPath = new Set<string>();
    let current: T | undefined = start;
    let boundary: boolean;

    for (;;) {
      // Parent absent from the list => root boundary (matches buildTree).
      if (current === undefined) { boundary = true; break; }

      const cached = visible.get(current.id);
      if (cached !== undefined) { boundary = cached; break; }

      // Revisiting a node on the current path => parentId cycle: fail closed.
      if (onPath.has(current.id)) { boundary = false; break; }

      if (!accessiblePageIds.has(current.id)) {
        // Inaccessible ancestor: it (and everything stacked below it) is hidden.
        visible.set(current.id, false);
        boundary = false;
        break;
      }

      if (current.parentId === null) {
        // Accessible root: it is visible; stacked descendants inherit that.
        visible.set(current.id, true);
        boundary = true;
        break;
      }

      pending.push(current);
      onPath.add(current.id);
      current = byId.get(current.parentId);
    }

    // Every node still pending was accessible and shares the boundary's verdict.
    for (const node of pending) {
      visible.set(node.id, boundary);
    }

    return visible.get(start.id) ?? boundary;
  }

  return nodes.filter(isVisible);
}
