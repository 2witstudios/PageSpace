import { buildPagePath } from '@/lib/tree/tree-utils';

export type PageContextInput = {
  page: { id: string; title: string; type: string };
  driveId: string;
  drives: Array<{ id: string; name: string; slug?: string }>;
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pagePathInfo = buildPagePath(cachedTree as any, page.id, driveId);

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
