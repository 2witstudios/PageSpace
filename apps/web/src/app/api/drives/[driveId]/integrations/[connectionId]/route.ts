import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import { getConnectionById, deleteConnection } from '@pagespace/lib/integrations';

const AUTH_OPTIONS_READ = { allow: ['session'] as const };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/**
 * GET /api/drives/[driveId]/integrations/[connectionId]
 * Get a specific drive integration connection.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string; connectionId: string }> }
) {
  const { driveId, connectionId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  try {
    const access = await getDriveAccess(driveId, auth.userId);
    if (!access.isMember) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const connection = await getConnectionById(db, connectionId);
    if (!connection || connection.driveId !== driveId) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
    }

    return NextResponse.json({
      connection: {
        id: connection.id,
        providerId: connection.providerId,
        name: connection.name,
        status: connection.status,
        statusMessage: connection.statusMessage,
        accountMetadata: connection.accountMetadata,
        baseUrlOverride: connection.baseUrlOverride,
        lastUsedAt: connection.lastUsedAt,
        createdAt: connection.createdAt,
      },
    });
  } catch (error) {
    loggers.api.error('Error fetching drive integration:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch integration' }, { status: 500 });
  }
}

/**
 * DELETE /api/drives/[driveId]/integrations/[connectionId]
 * Delete a drive integration connection. Cascades to grants.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ driveId: string; connectionId: string }> }
) {
  const { driveId, connectionId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  try {
    const access = await getDriveAccess(driveId, auth.userId);
    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const connection = await getConnectionById(db, connectionId);
    if (!connection || connection.driveId !== driveId) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
    }

    await deleteConnection(db, connectionId);
    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting drive integration:', error as Error);
    return NextResponse.json({ error: 'Failed to delete integration' }, { status: 500 });
  }
}
