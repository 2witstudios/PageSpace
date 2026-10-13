import type { SelectedPageInfo } from '@/retained/stores/useMultiSelectStore';

type TreeNode = { readonly id: string; readonly children?: readonly TreeNode[] };

/** The drive tree's key (the one the Files pane's page tree reads and refreshes). */
export const driveTreeKey = (driveId: string): string => `/api/drives/${encodeURIComponent(driveId)}/pages`;

/** Whether the page has pages inside it, from the drive's page tree; false until it loads. */
export const hasChildrenIn = (tree: unknown, pageId: string): boolean => {
  const find = (nodes: readonly TreeNode[]): TreeNode | undefined => {
    for (const node of nodes) {
      if (node.id === pageId) return node;
      const inner = find(node.children ?? []);
      if (inner !== undefined) return inner;
    }
    return undefined;
  };
  return Array.isArray(tree) && (find(tree as readonly TreeNode[])?.children?.length ?? 0) > 0;
};

/** The page as Move to… and Copy to… take it. */
export const selectedPageOf = (
  pageId: string,
  driveId: string,
  page: { readonly title: string; readonly type: string; readonly parentId: string | null },
): SelectedPageInfo => ({ id: pageId, title: page.title, type: page.type, driveId, parentId: page.parentId });
