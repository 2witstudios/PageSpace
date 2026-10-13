import { canPrincipalViewPage, getPrincipalBatchPagePermissions } from '@/lib/auth/principal-permissions';
import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { and, eq, asc, isNotNull } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { taskItems } from '@pagespace/db/schema/tasks';

import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { jsonResponse } from '@pagespace/lib/utils/api-utils';
import { actorFromAuth, deniedResponse } from '@/lib/auth/request-actor';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false } as const;

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;

  // Support both Bearer tokens (desktop) and cookies (web)
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const canView = await canPrincipalViewPage(auth, pageId);
  if (!canView) {
    return deniedResponse(actorFromAuth(auth), pageId, new NextResponse("Forbidden", { status: 403 }));
  }

  try {
    // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
    const listed = await db.query.pages.findMany({
      where: and(
        eq(pages.parentId, pageId),
        eq(pages.isTrashed, false)
      ),
      orderBy: [asc(pages.position)],
    });
    // Viewing the parent opens no child: each child is returned only if the caller may view it itself (a private
    // child, or a memory page an org's sign-in policy withholds from this credential, D-OW-62, is left out).
    const permissions = await getPrincipalBatchPagePermissions(auth, listed.map((child) => child.id));
    const children = listed.filter((child) => permissions.get(child.id)?.canView);

    // Get task-linked page IDs to mark them
    const taskLinkedPageIds = await db.selectDistinct({ pageId: taskItems.pageId })
      .from(taskItems)
      .where(isNotNull(taskItems.pageId));
    const taskLinkedSet = new Set(taskLinkedPageIds.map(t => t.pageId));

    // Add isTaskLinked flag to each child
    const childrenWithTaskInfo = children.map(child => ({
      ...child,
      isTaskLinked: taskLinkedSet.has(child.id),
    }));

    auditRequest(req, { eventType: 'data.read', userId: auth.userId, resourceType: 'page_children', resourceId: pageId, details: { action: 'list_children', count: childrenWithTaskInfo.length } });

    return jsonResponse(childrenWithTaskInfo);
  } catch (error) {
    loggers.api.error(`Error fetching children for page ${pageId}:`, error as Error);
    return NextResponse.json({ error: 'Failed to fetch page children' }, { status: 500 });
  }
}