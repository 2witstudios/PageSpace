import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { zoomConnections } from '@pagespace/db/schema/zoom';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const settingsSchema = z.object({
  targetDriveId: z.string().min(1).nullable().optional(),
  targetFolderId: z.string().nullable().optional(),
  includeAiSummary: z.boolean().optional(),
  includeActionItems: z.boolean().optional(),
  includeTranscript: z.boolean().optional(),
});

export async function GET(request: Request) {
  if (isOnPrem()) return Response.json({ error: 'Not available' }, { status: 404 });

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const connection = await db.query.zoomConnections.findFirst({
      where: eq(zoomConnections.userId, userId),
      columns: {
        targetDriveId: true,
        targetFolderId: true,
        includeAiSummary: true,
        includeActionItems: true,
        includeTranscript: true,
      },
    });

    if (!connection) {
      return NextResponse.json({ error: 'No connection found' }, { status: 404 });
    }

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'zoom_settings', resourceId: 'self' });

    return NextResponse.json({ settings: connection });
  } catch (error) {
    loggers.api.error('Error fetching Zoom settings', error as Error);
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  if (isOnPrem()) return Response.json({ error: 'Not available' }, { status: 404 });

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    let body: unknown;
    try { body = await request.json(); } catch { body = {}; }
    const validation = settingsSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid settings', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const connection = await db.query.zoomConnections.findFirst({
      where: eq(zoomConnections.userId, userId),
      columns: { id: true },
    });

    if (!connection) {
      return NextResponse.json({ error: 'No connection found' }, { status: 404 });
    }

    const updates = validation.data;
    const setValues: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.targetDriveId !== undefined) setValues.targetDriveId = updates.targetDriveId;
    if (updates.targetFolderId !== undefined) setValues.targetFolderId = updates.targetFolderId;
    if (updates.includeAiSummary !== undefined) setValues.includeAiSummary = updates.includeAiSummary;
    if (updates.includeActionItems !== undefined) setValues.includeActionItems = updates.includeActionItems;
    if (updates.includeTranscript !== undefined) setValues.includeTranscript = updates.includeTranscript;

    await db.update(zoomConnections).set(setValues).where(eq(zoomConnections.userId, userId));

    loggers.api.info('Zoom settings updated', { userId, updates });
    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'zoom_settings', resourceId: 'self', details: { operation: 'update' } });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error updating Zoom settings', error as Error);
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
}
