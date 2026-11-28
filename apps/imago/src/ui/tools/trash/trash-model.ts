// The trash view's pure model: apps/web's trashed tree flattened into the
// rows the treegrid draws, the Type filter, and the edits a restore or a
// permanent delete makes to the tree.

import type { PageTypeValue } from '@pagespace/lib/client-safe';

/** One node of GET /api/drives/[driveId]/trash (apps/web buildTree over the drive's trashed pages). */
export type TrashPage = {
  readonly id: string;
  readonly title: string;
  readonly type: PageTypeValue;
  readonly parentId: string | null;
  /** The parent a top-level trashed page had before it was trashed. */
  readonly originalParentId: string | null;
  readonly position: number;
  /** When the page was trashed, as an ISO string. */
  readonly trashedAt: string | null;
  /** Bytes, for an uploaded file; null otherwise. */
  readonly fileSize?: number | null;
  readonly children?: readonly TrashPage[];
};

export type TrashRow = {
  readonly id: string;
  readonly title: string;
  readonly type: PageTypeValue;
  /** 0 for a page trashed on its own; children sit under their trashed folder. */
  readonly depth: number;
  /** A top-level row: the one Restore and Delete forever act on. */
  readonly top: boolean;
  readonly originalParentId: string | null;
  /** The title of the folder this row sits under, for a child row. */
  readonly parentTitle: string | null;
  readonly trashedAt: string | null;
  readonly fileSize: number | null;
  /** Pages inside this one, at any depth. */
  readonly descendants: number;
};

export const TRASH_FILTERS = ['all', 'pages', 'files'] as const;
export type TrashFilter = (typeof TRASH_FILTERS)[number];

/** The filter a `?type=` query asks for; anything unknown is All. */
export const trashFilterFrom = (value: string | null): TrashFilter =>
  value === 'pages' || value === 'files' ? value : 'all';

export const countDescendants = (page: TrashPage): number =>
  (page.children ?? []).reduce((total, child) => total + 1 + countDescendants(child), 0);

/** The tree, depth first, each folder's pages right after it. */
export function trashRows(tree: readonly TrashPage[]): readonly TrashRow[] {
  const rows: TrashRow[] = [];
  const walk = (nodes: readonly TrashPage[], depth: number, parentTitle: string | null): void => {
    for (const node of nodes) {
      rows.push({
        id: node.id,
        title: node.title,
        type: node.type,
        depth,
        top: depth === 0,
        originalParentId: node.originalParentId,
        parentTitle,
        trashedAt: node.trashedAt,
        fileSize: node.fileSize ?? null,
        descendants: countDescendants(node),
      });
      walk(node.children ?? [], depth + 1, node.title);
    }
  };
  walk(tree, 0, null);
  return rows;
}

/** Rows the Type filter keeps: Files are FILE pages, Pages are everything else. */
export const rowsMatching = (rows: readonly TrashRow[], filter: TrashFilter): readonly TrashRow[] => {
  if (filter === 'all') return rows;
  const wantFiles = filter === 'files';
  return rows.filter((row) => (row.type === 'FILE') === wantFiles);
};

/**
 * "Was in": a child shows the folder it sits under; a top-level page shows
 * the parent it had, looked up by id, or nothing when that parent is unknown.
 */
export const wasInLabel = (row: TrashRow, titles: ReadonlyMap<string, string>): string | null => {
  if (row.depth > 0) return row.parentTitle;
  if (row.originalParentId === null) return null;
  return titles.get(row.originalParentId) ?? null;
};

/** The tree with one page, and everything inside it, taken out. */
export const withoutPage = (tree: readonly TrashPage[], pageId: string): readonly TrashPage[] =>
  tree
    .filter((node) => node.id !== pageId)
    .map((node) => ({ ...node, children: withoutPage(node.children ?? [], pageId) }));

/** A page's size in the Name column's meta: a file's bytes, a folder's page count. */
export const metaLabel = (row: TrashRow): string | null => {
  if (row.type === 'FILE') return row.fileSize === null ? null : formatBytes(row.fileSize);
  if (row.descendants === 0) return null;
  return row.descendants === 1 ? '1 page' : `${row.descendants} pages`;
};

export const formatBytes = (bytes: number): string => {
  const KB = 1024;
  const MB = KB * 1024;
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "Today", "Yesterday", or "Oct 6": when a page was trashed, read against today. */
export const trashedLabel = (iso: string | null, now: Date): string => {
  if (iso === null) return '—';
  const when = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(when)) / DAY_MS);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

/** The sentence under the inline confirm: what a permanent delete takes with it. */
export const deleteDetail = (row: TrashRow): string => {
  if (row.descendants === 0) return 'Its content and version history can’t be restored after this.';
  const inside = row.descendants === 1 ? '1 page' : `${row.descendants} pages`;
  return `Its content, version history and the ${inside} inside it can’t be restored after this.`;
};
