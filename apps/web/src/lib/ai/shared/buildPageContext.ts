import { buildPagePath } from '@/lib/tree/tree-utils';
import type { TreePage } from '@/hooks/usePageTree';
import type { LocationContext } from './chat-types';

export type PageContextInput = {
  page: { id: string; title: string; type: string };
  driveId: string;
  drives: Array<{ id: string; name: string; slug?: string }>;
  /** Structural subset of TreePage[] — only id/title/children are accessed by buildPagePath */
  cachedTree: Array<{ id: string; title: string; children?: unknown[] }>;
  fetchBreadcrumbs: (pageId: string) => Promise<Array<{ title?: string }>>;
};

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

export async function buildPageContext(input: PageContextInput): Promise<PageContext> {
  const { page, driveId, drives, cachedTree, fetchBreadcrumbs } = input;

  const currentDrive = drives.find((d) => d.id === driveId);

  const pagePathInfo = buildPagePath(cachedTree as unknown as TreePage[], page.id, driveId);

  let breadcrumbs: string[] = pagePathInfo?.breadcrumbs ?? [driveId, page.title];
  let pagePath: string = pagePathInfo?.path ?? `/${driveId}/${page.title}`;
  let parentPath: string = pagePathInfo?.parentPath ?? `/${driveId}`;

  if (!pagePathInfo) {
    try {
      const breadcrumbItems = await fetchBreadcrumbs(page.id);
      const titles = breadcrumbItems
        .map((item) => item.title?.trim())
        .filter((t): t is string => Boolean(t));

      if (titles.length > 0) {
        breadcrumbs = [driveId, ...titles];
        pagePath = `/${driveId}/${titles.map((t) => encodeURIComponent(t)).join('/')}`;
        parentPath =
          titles.length > 1
            ? `/${driveId}/${titles.slice(0, -1).map((t) => encodeURIComponent(t)).join('/')}`
            : `/${driveId}`;
      }
    } catch {
      // keep defaults
    }
  }

  return {
    pageId: page.id,
    pageTitle: page.title,
    pageType: page.type,
    pagePath,
    parentPath,
    breadcrumbs,
    driveId: currentDrive?.id ?? driveId,
    driveName: currentDrive?.name ?? driveId,
    driveSlug: currentDrive?.slug,
  };
}

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
