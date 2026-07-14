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
