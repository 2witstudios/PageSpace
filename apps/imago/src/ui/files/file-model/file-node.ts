// Imago's file tree model, and the apps/web shapes it is built from.
//
// The *Response types mirror what the page route handlers actually return
// (apps/web/src/app/api/drives/[driveId]/pages/route.ts, which nests the
// drive's pages with buildTree, and apps/web/src/app/api/pages/[pageId]/
// children/route.ts, which lists one page's direct children flat): they are
// read from those handlers, not invented, and keep only the fields imago
// reads. Dates arrive as ISO strings (jsonResponse serializes them).

import type { PageTypeValue } from '@pagespace/lib/client-safe';

/** One page row as both routes send it. */
export type PageResponse = {
  readonly id: string;
  readonly title: string;
  readonly type: PageTypeValue;
  readonly parentId: string | null;
  readonly position: number;
  readonly isTrashed: boolean;
};

/**
 * A page in GET /api/drives/[driveId]/pages: every page carries its children.
 * GET /api/pages/[pageId]/children answers PageResponse rows with none.
 */
export type PageTreeResponse = PageResponse & { readonly children?: readonly PageTreeResponse[] };

/** How a node opens: a folder in the folder browser, anything else as its object. */
export type FileKind = 'folder' | 'page';

/**
 * A node of the files tree (myimago's ui/types FileNode), carrying its
 * PageSpace page type so a view can pick the page's icon and object view.
 *
 * Unlike myimago's mock, any PageSpace page can hold pages: a folder always
 * carries `children` (empty when it holds nothing), and another page carries
 * them only when it has some.
 */
export type FileNode = {
  readonly id: string;
  readonly name: string;
  readonly kind: FileKind;
  readonly pageType: PageTypeValue;
  /** Item count shown beside a folder: its direct children. */
  readonly count?: number;
  readonly children?: readonly FileNode[];
};
