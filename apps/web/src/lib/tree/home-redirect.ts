import type { TreePage } from '@/hooks/usePageTree';
import { findNodeAndParent } from './tree-utils';

/**
 * The single redirect decision for the drive home page feature: a drive-root
 * visit redirects to the home page iff it is present in the user's loaded
 * page tree. The tree API is permission-filtered and excludes trashed pages,
 * so absence means trashed, deleted, or not viewable — all of which fall back
 * to the default drive-root view.
 */
export function resolveHomeRedirectTarget(
  homePageId: string | null | undefined,
  tree: TreePage[]
): string | null {
  if (!homePageId) {
    return null;
  }

  return findNodeAndParent(tree, homePageId) ? homePageId : null;
}
