// Builders for the apps/web response shapes the files tests feed in. Every
// field the routes return is present (content, flags, timestamps), so a
// mapping that reads the wrong one fails.

import type { PageTypeValue } from '@pagespace/lib/client-safe';
import type { PageResponse, PageTreeResponse } from './file-node';

/** A pages row as the children route sends it: no `children`. */
export const pageRow = (
  id: string,
  type: PageTypeValue,
  overrides: Partial<PageResponse> = {},
): PageResponse => {
  const row = {
    id,
    title: `Title ${id}`,
    type,
    content: '<p>body</p>',
    contentMode: 'html',
    parentId: null,
    position: 0,
    isTrashed: false,
    isPrivate: false,
    driveId: 'd1',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    trashedAt: null,
    originalParentId: null,
    isTaskLinked: false,
    ...overrides,
  };
  return row;
};

/** A row of the drive tree: the same row with its children nested, as buildTree leaves it. */
export const treeRow = (
  id: string,
  type: PageTypeValue,
  children: readonly PageTreeResponse[] = [],
  overrides: Partial<PageResponse> = {},
): PageTreeResponse => {
  const flags = { hasChanges: false };
  return { ...pageRow(id, type, overrides), ...flags, children };
};
