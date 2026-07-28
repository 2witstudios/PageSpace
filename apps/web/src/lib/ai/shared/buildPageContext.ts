import type { LocationContext } from './chat-types';

export type PageContext = {
  pageId: string;
  pageTitle: string;
  pageType: string;
  pagePath: string;
  parentPath: string;
  breadcrumbs: string[];
  driveId: string;
  driveName: string;
  driveSlug: string | undefined;
};

/**
 * Adapt the sidebar's nested `LocationContext` (currentPage/currentDrive) to
 * the flat `PageContext` shape `/api/ai/chat` actually reads. Returns
 * undefined when there's no current page — matches `pageContext`'s existing
 * optionality server-side.
 */
/**
 * Inverse of `locationContextToPageContext`, for the one caller that still
 * receives a flat `PageContext` first: legacy clients that send no `contextRef`.
 *
 * `PageContext` cannot represent a drive-level location (it requires a page), so
 * the chat route normalizes BOTH sources to `LocationContext` before use — one
 * object feeds the model prompt and the tool context alike. Without that, a
 * drive-only route gave tools a `currentDrive` while the prompt still said
 * "operating from the dashboard": tools would quietly act on a workspace the
 * model had been told it wasn't in.
 */
export function pageContextToLocationContext(
  // Structural, not `PageContext`: the legacy client-supplied shape carries an
  // OPTIONAL driveId, and this adapter exists precisely to serve that caller.
  page:
    | (Omit<PageContext, 'driveId' | 'driveSlug'> & { driveId?: string; driveSlug?: string })
    | null
    | undefined,
): LocationContext | null {
  if (!page) return null;
  return {
    currentPage: {
      id: page.pageId,
      title: page.pageTitle,
      type: page.pageType,
      path: page.pagePath,
    },
    currentDrive: page.driveId
      ? { id: page.driveId, name: page.driveName, slug: page.driveSlug ?? '' }
      : null,
    breadcrumbs: page.breadcrumbs,
  };
}

export function locationContextToPageContext(loc: LocationContext | null | undefined): PageContext | undefined {
  const page = loc?.currentPage;
  if (!page) return undefined;

  const drive = loc?.currentDrive;
  const pathSegments = page.path.split('/').filter(Boolean);
  const parentPath = pathSegments.length > 1
    ? `/${pathSegments.slice(0, -1).join('/')}`
    : '/';

  return {
    pageId: page.id,
    pageTitle: page.title,
    pageType: page.type,
    pagePath: page.path,
    parentPath,
    breadcrumbs: loc?.breadcrumbs ?? [],
    driveId: drive?.id ?? '',
    driveName: drive?.name ?? '',
    driveSlug: drive?.slug,
  };
}
