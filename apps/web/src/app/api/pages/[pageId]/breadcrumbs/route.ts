import { NextResponse } from 'next/server';
import { decodeToken, canUserViewPage } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { pages, db, eq } from '@pagespace/db';

type BreadcrumbPage = (typeof pages.$inferSelect) & { drive: { id: string; slug: string; name: string } | null };

async function getBreadcrumbs(pageId: string): Promise<BreadcrumbPage[]> {
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
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

  if (!page) {
    return [];
  }

  if (!page.parentId) {
    return [page as BreadcrumbPage];
  }

  const parentBreadcrumbs = await getBreadcrumbs(page.parentId);
  return [...parentBreadcrumbs, page as BreadcrumbPage];
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
