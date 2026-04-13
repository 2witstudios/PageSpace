import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isUserDriveMember } from '@pagespace/lib';
import { auditRequest } from '@pagespace/lib/server';
import { db, pages, eq, and } from '@pagespace/db';

// GET /api/workflows/agents?driveId=xxx - List AI_CHAT pages in a drive
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, { allow: ['session'] as const, requireCSRF: false });
  if (isAuthError(auth)) return auth.error;

  const { searchParams } = new URL(request.url);
  const driveId = searchParams.get('driveId');

  if (!driveId) {
    return NextResponse.json({ error: 'driveId is required' }, { status: 400 });
  }

  const isMember = await isUserDriveMember(auth.userId, driveId);
  if (!isMember) {
    return NextResponse.json({ error: 'Not a member of this drive' }, { status: 403 });
  }

  const agents = await db
    .select({ id: pages.id, title: pages.title, type: pages.type })
    .from(pages)
    .where(
      and(
        eq(pages.driveId, driveId),
        eq(pages.type, 'AI_CHAT'),
        eq(pages.isTrashed, false)
      )
    )
    .orderBy(pages.title);

  auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'agent', resourceId: driveId, details: { count: agents.length } });

  return NextResponse.json(agents);
}
