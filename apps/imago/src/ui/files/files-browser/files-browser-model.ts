// What the folder browser shows and links to, from the drive tree's file nodes.

import type { PageTypeValue } from '@pagespace/lib/client-safe';
import type { FileNode } from '../file-model/file-node';
import { pathTo } from '../tree-view/tree-view';

/** The view the viewer last chose, remembered in this browser. */
export const VIEW_STORAGE_KEY = 'imago:files-view';

export type FilesView = 'list' | 'grid';

/** Anything but a stored "grid" reads as the list, the view a browser opens in. */
export const viewOf = (stored: string | null): FilesView => (stored === 'grid' ? 'grid' : 'list');

/** The Type column: the page type's enum name in title case ("Ai Chat", "Task List"), as the board draws it. */
export const typeLabelOf = (pageType: PageTypeValue): string =>
  pageType
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

/** A date as M/D/YYYY, the way the Last Modified column reads it. */
export const shortDate = (iso: string): string => new Date(iso).toLocaleDateString('en-US');

/** A page's address in the files section, under the drive. */
export const fileHref = (driveId: string, pageId: string): string =>
  `/${encodeURIComponent(driveId)}/files/${encodeURIComponent(pageId)}`;

/** A folder's browser address: /[driveId]/files/browse/<the folder path's ids>. */
export const browseHref = (driveId: string, path: readonly FileNode[]): string =>
  `/${encodeURIComponent(driveId)}/files/browse${path.map((node) => `/${encodeURIComponent(node.id)}`).join('')}`;

/**
 * The folder a route names. The ids are the path from the top of the drive
 * down, so the drive tree must list exactly that chain and end in a folder.
 * An empty id list is the drive's top. Anything else is undefined.
 */
export const resolveFolder = (nodes: readonly FileNode[], ids: readonly string[]): readonly FileNode[] | undefined => {
  if (ids.length === 0) return [];
  const path = pathTo(nodes, ids[ids.length - 1]);
  if (path === undefined) return undefined;
  if (path.map((node) => node.id).join('/') !== ids.join('/')) return undefined;
  return path[path.length - 1].kind === 'folder' ? path : undefined;
};
