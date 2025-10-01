import { NextResponse } from 'next/server';
import { decodeToken, canUserViewPage } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { pages, db, eq } from '@pagespace/db';

type BreadcrumbPage = (typeof pages.$inferSelect) & { drive: { id: string; slug: string; name: string } | null };

async function getBreadcrumbs(pageId: string): Promise<BreadcrumbPage[]> {
  const breadcrumbs: BreadcrumbPage[] = [];
  const visited = new Set<string>();
  let currentId: string | null = pageId;
  const MAX_DEPTH = 100;
  let depth = 0;

  while (currentId) {
    depth++;

    // Depth limit check
    if (depth > MAX_DEPTH) {
      console.error(`Breadcrumb computation exceeded max depth ${MAX_DEPTH} for page ${pageId}`);
      break;
    }

    // Cycle detection
    if (visited.has(currentId)) {
      console.error(`Circular reference detected in breadcrumbs for page ${pageId} at page ${currentId}`);
      break;
    }
    visited.add(currentId);

    // Fetch page
    const page: BreadcrumbPage | undefined = await db.query.pages.findFirst({
      where: eq(pages.id, currentId),
      with: {
        drive: {
          columns: {
            id: true,
            slug: true,
            name: true,
          },
        },
      },
    });

    if (!page) break;

    breadcrumbs.unshift(page as BreadcrumbPage);
    currentId = page.parentId;
  }

  return breadcrumbs;
}

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const cookieHeader = req.headers.get('cookie');
  const cookies = parse(cookieHeader || '');
  const accessToken = cookies.accessToken;

  if (!accessToken) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const decoded = await decodeToken(accessToken);
  if (!decoded?.userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const canView = await canUserViewPage(decoded.userId, pageId);
  if (!canView) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const breadcrumbs = await getBreadcrumbs(pageId);
  return NextResponse.json(breadcrumbs);
}
