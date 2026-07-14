import { NextResponse } from 'next/server';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getPageBreadcrumbTrail } from '@/lib/pages/get-page-breadcrumb-trail';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false } as const;

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;

  // Support both Bearer tokens (desktop) and cookies (web)
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const canView = await canUserViewPage(auth.userId, pageId);
  if (!canView) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const breadcrumbs = await getPageBreadcrumbTrail(pageId);

  auditRequest(req, { eventType: 'data.read', userId: auth.userId, resourceType: 'page_breadcrumb', resourceId: pageId, details: { action: 'get_breadcrumbs', depth: breadcrumbs.length } });

  return NextResponse.json(breadcrumbs);
}
