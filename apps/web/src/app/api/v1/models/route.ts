import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq, and, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { PageType } from '@pagespace/lib/utils/enums';
import { getBatchPagePermissions } from '@pagespace/lib/permissions/permissions';
import {
  authenticateRequestWithOptions,
  isAuthError,
  getAllowedDriveIds,
} from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['mcp'] as const, requireCSRF: false };

export async function GET(request: Request): Promise<Response> {
  const authResult = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(authResult)) return authResult.error;

  const allowedDriveIds = getAllowedDriveIds(authResult);

  const whereClause = allowedDriveIds.length > 0
    ? and(eq(pages.type, PageType.AI_CHAT), eq(pages.isTrashed, false), inArray(pages.driveId, allowedDriveIds))
    : and(eq(pages.type, PageType.AI_CHAT), eq(pages.isTrashed, false));

  const rows = await db.select().from(pages).where(whereClause);
  const permissions = await getBatchPagePermissions(authResult.userId, rows.map((r) => r.id));

  const models = rows
    .filter((page) => permissions.get(page.id)?.canView)
    .map((page) => ({
      id: `ps-agent://${page.id}`,
      object: 'model' as const,
      created: Math.floor(page.createdAt.getTime() / 1000),
      owned_by: 'pagespace',
    }));

  return NextResponse.json({ object: 'list', data: models });
}
