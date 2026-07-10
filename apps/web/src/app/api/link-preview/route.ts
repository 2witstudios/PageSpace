import { NextResponse } from 'next/server';
import { z } from 'zod';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages, drives } from '@pagespace/db/schema/core';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { verifyAuth } from '@/lib/auth/auth';

const bodySchema = z.object({
  pageId: z.string().min(1),
  driveId: z.string().optional(),
});

export async function POST(request: Request) {
  const user = await verifyAuth(request);
  if (!user) {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      resourceType: 'link_preview',
      resourceId: 'unknown',
      details: { reason: 'auth_failed' },
      riskScore: 0.3,
    });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'pageId is required' }, { status: 400 });
  }

  const { pageId } = parsed.data;

  const canView = await canUserViewPage(user.id, pageId);
  if (!canView) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const rows = await db
    .select({
      id: pages.id,
      title: pages.title,
      type: pages.type,
      driveId: pages.driveId,
      isTrashed: pages.isTrashed,
      content: pages.content,
      driveName: drives.name,
    })
    .from(pages)
    .innerJoin(drives, eq(drives.id, pages.driveId))
    .where(eq(pages.id, pageId));

  const page = rows[0];
  if (!page || page.isTrashed) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const result: {
    id: string;
    title: string;
    type: string;
    driveId: string;
    driveName: string;
    snippet?: string;
  } = {
    id: page.id,
    title: page.title,
    type: page.type,
    driveId: page.driveId,
    driveName: page.driveName,
  };

  if (page.type === 'DOCUMENT' && page.content) {
    result.snippet = page.content.slice(0, 100);
  }

  auditRequest(request, {
    eventType: 'data.read',
    userId: user.id,
    resourceType: 'link_preview',
    resourceId: pageId,
    riskScore: 0.1,
  });

  return NextResponse.json(result);
}
