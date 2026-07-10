import { NextResponse } from 'next/server';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, and, desc, inArray } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import {
  buildCreateConversationPayload,
  buildConversationListQuery,
} from '@/lib/ai/openai-api/v1-conversations';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError, getAllowedDriveIds } from '@/lib/auth/auth-core';

const AUTH_OPTIONS = { allow: ['mcp'] as const, requireCSRF: false };

export async function POST(request: Request): Promise<Response> {
  const authResult = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(authResult)) return authResult.error;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const allowedDriveIds = getAllowedDriveIds(authResult);
  const id = createId();
  const result = buildCreateConversationPayload(rawBody, authResult.userId, allowedDriveIds, id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  await db.insert(conversations).values({
    id: result.data.id,
    userId: result.data.userId,
    title: result.data.title,
    type: result.data.type,
    contextId: result.data.contextId,
    updatedAt: result.data.updatedAt,
  });

  auditRequest(request, { eventType: 'data.write', userId: authResult.userId, resourceType: 'conversation', resourceId: result.data.id, details: { action: 'create' }, riskScore: 0 });

  return NextResponse.json(
    {
      id: result.data.id,
      object: 'conversation',
      created_at: Math.floor(Date.now() / 1000),
      user_id: result.data.userId,
      title: result.data.title,
      drive_id: result.data.contextId,
    },
    { status: 201 },
  );
}

export async function GET(request: Request): Promise<Response> {
  const authResult = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(authResult)) return authResult.error;

  const url = new URL(request.url);
  const queryResult = buildConversationListQuery(authResult.userId, url.searchParams);
  if (!queryResult.ok) {
    return NextResponse.json({ error: queryResult.error }, { status: queryResult.status });
  }

  const { userId, limit, offset, driveId } = queryResult.data;
  const allowedDriveIds = getAllowedDriveIds(authResult);

  // Enforce MCP drive scope on listing
  if (allowedDriveIds.length > 0 && driveId !== undefined && !allowedDriveIds.includes(driveId)) {
    return NextResponse.json({ error: 'Drive not accessible with this token' }, { status: 403 });
  }

  const conditions = [eq(conversations.userId, userId), eq(conversations.isActive, true)];
  if (driveId !== undefined) {
    conditions.push(eq(conversations.contextId, driveId));
  } else if (allowedDriveIds.length > 0) {
    conditions.push(inArray(conversations.contextId, allowedDriveIds));
  }

  const rows = await db
    .select()
    .from(conversations)
    .where(and(...conditions))
    .orderBy(desc(conversations.updatedAt))
    .limit(limit)
    .offset(offset);

  auditRequest(request, { eventType: 'data.read', userId: authResult.userId, resourceType: 'conversation', resourceId: 'list', details: { driveId: queryResult.data.driveId }, riskScore: 0 });

  return NextResponse.json({
    object: 'list',
    data: rows.map((row) => ({
      id: row.id,
      object: 'conversation',
      created_at: Math.floor(row.createdAt.getTime() / 1000),
      user_id: row.userId,
      title: row.title,
      drive_id: row.contextId,
    })),
  });
}
