// The drive's page tree with lazily loaded children merged in.
//
// GET /api/drives/[driveId]/pages answers the whole tree the viewer may see;
// GET /api/pages/[pageId]/children answers one page's children, flat. A load
// of children is kept beside the tree rather than written into it, and shown
// only while it is newer than the tree: once a socket event revalidates the
// drive, the fresh tree has the last word.

import { byPosition } from '../file-model/from-api';
import type { PageResponse, PageTreeResponse } from '../file-model/file-node';

// Each answer carries `at`: when it was asked for, on one clock shared by
// every request, so the later question wins whatever order answers land in.

export type TreeAnswer = { readonly pages: readonly PageTreeResponse[]; readonly at: number };

export type ChildrenAnswer = { readonly children: readonly PageResponse[]; readonly at: number };

/** Children loads by parent page id. */
export type LoadedChildren = Readonly<Record<string, ChildrenAnswer>>;

/**
 * `pages` with `parentId`'s children replaced by `children`. A child the tree
 * already held keeps what is known below it; a new one has unknown children.
 * The same tree comes back when it does not hold `parentId`.
 */
export const mergeChildren = (
  pages: readonly PageTreeResponse[],
  parentId: string,
  children: readonly PageResponse[],
): readonly PageTreeResponse[] => {
  let found = false;
  const walk = (level: readonly PageTreeResponse[]): readonly PageTreeResponse[] => {
    let changed = false;
    const next = level.map((page) => {
      if (page.id === parentId) {
        found = true;
        changed = true;
        const known = new Map((page.children ?? []).map((child) => [child.id, child.children]));
        return {
          ...page,
          children: byPosition(children).map((child): PageTreeResponse => {
            const below = known.get(child.id);
            return below === undefined ? child : { ...child, children: below };
          }),
        };
      }
      if (found || page.children === undefined) return page;
      const below = walk(page.children);
      if (below === page.children) return page;
      changed = true;
      return { ...page, children: below };
    });
    return changed ? next : level;
  };
  return walk(pages);
};

/** The tree as it stands: children loads newer than the tree, oldest first. */
export const composeTree = (tree: TreeAnswer, loaded: LoadedChildren): readonly PageTreeResponse[] =>
  Object.entries(loaded)
    .filter(([, load]) => load.at > tree.at)
    .sort(([, a], [, b]) => a.at - b.at)
    .reduce((pages, [parentId, load]) => mergeChildren(pages, parentId, load.children), tree.pages);

/** `pages` with `pageId` titled `title`; the same tree when it does not hold the page. */
export const renamePage = <P extends PageResponse & { readonly children?: readonly P[] }>(
  pages: readonly P[],
  pageId: string,
  title: string,
): readonly P[] => {
  let changed = false;
  const next = pages.map((page): P => {
    if (page.id === pageId) {
      changed = true;
      return { ...page, title };
    }
    if (page.children === undefined) return page;
    const below = renamePage(page.children, pageId, title);
    if (below === page.children) return page;
    changed = true;
    return { ...page, children: below };
  });
  return changed ? next : pages;
};
