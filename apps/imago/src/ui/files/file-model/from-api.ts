// apps/web's page tree answers, mapped into imago's file nodes.

import { PageType } from '@pagespace/lib/client-safe';
import type { FileNode, PageTreeResponse } from './file-node';

/** Siblings in the order the sidebar shows them; the server sends them this way, merges keep it. */
export const byPosition = <T extends { readonly position: number }>(pages: readonly T[]): readonly T[] =>
  [...pages].sort((a, b) => a.position - b.position);

const visible = (pages: readonly PageTreeResponse[]): readonly PageTreeResponse[] =>
  byPosition(pages.filter((page) => !page.isTrashed));

/**
 * One page as a file node. A page whose children the answer did not carry
 * (a children-route row) gets none, so a view can tell "not loaded" from
 * "empty".
 */
const fileNodeFrom = (page: PageTreeResponse): FileNode => {
  const node = { id: page.id, name: page.title, pageType: page.type, updatedAt: page.updatedAt };
  const children = page.children === undefined ? undefined : fileNodesFrom(page.children);
  if (page.type === PageType.FOLDER) {
    return children === undefined
      ? { ...node, kind: 'folder' }
      : { ...node, kind: 'folder', count: children.length, children };
  }
  return children === undefined || children.length === 0
    ? { ...node, kind: 'page' }
    : { ...node, kind: 'page', children };
};

/**
 * A drive's page tree (or a page's children) as file nodes, in position
 * order. Trashed pages are left out, as the server already does.
 */
export const fileNodesFrom = (pages: readonly PageTreeResponse[]): readonly FileNode[] =>
  visible(pages).map(fileNodeFrom);
