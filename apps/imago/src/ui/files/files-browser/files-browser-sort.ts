// The folder browser's column sort. The comparator is apps/web's
// FilesFinderContent comparator, copied: plain < and > on each column's value,
// so capitals sort before lowercase names and ISO dates sort by time.

import type { FileNode } from '../file-model/file-node';

/** The columns the browser can sort by. Created is not listed: the tree model carries no created time yet. */
export type SortKey = 'title' | 'type' | 'updatedAt';

export type SortDirection = 'asc' | 'desc';

export type SortState = { readonly key: SortKey; readonly dir: SortDirection };

/** The browser opens sorted by name, A to Z. */
export const DEFAULT_SORT: SortState = { key: 'title', dir: 'asc' };

/** What each column compares: a page's name, its page type, when it last changed. */
const fieldOf: Readonly<Record<SortKey, (node: FileNode) => string | undefined>> = {
  title: (node) => node.name,
  type: (node) => node.pageType,
  updatedAt: (node) => node.updatedAt,
};

/** Sorts a copy of the nodes; the input is left as it is. A missing value (a create still in flight) compares as empty. */
export const sortNodes = (nodes: readonly FileNode[], sort: SortState): readonly FileNode[] => {
  const field = fieldOf[sort.key];
  const sign = sort.dir === 'asc' ? 1 : -1;
  return nodes.slice().sort((a, b) => {
    const x = field(a) ?? '';
    const y = field(b) ?? '';
    if (x < y) return -sign;
    if (x > y) return sign;
    return 0;
  });
};

/** Clicking a column: the same column flips its direction; another column starts ascending. */
export const nextSort = (current: SortState, key: SortKey): SortState =>
  current.key === key
    ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: 'asc' };

/** The aria-sort value a column header carries. */
export const ariaSortOf = (current: SortState, key: SortKey): 'ascending' | 'descending' | 'none' => {
  if (current.key !== key) return 'none';
  return current.dir === 'asc' ? 'ascending' : 'descending';
};
