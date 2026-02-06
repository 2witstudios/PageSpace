import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, integrationConnections, eq } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import {
  getConnectionById,
  deleteConnection,
} from '@pagespace/lib/integrations';

const AUTH_OPTIONS_READ = { allow: ['session'] as const };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const patchConnectionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  visibility: z.enum(['private', 'owned_drives', 'all_drives']).optional(),
  configOverrides: z.record(z.string(), z.unknown()).optional(),
});

/**
 * GET /api/user/integrations/[connectionId]
 * Get a specific user integration connection.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ connectionId: string }> }
) {
  const { connectionId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  try {
    const connection = await getConnectionById(db, connectionId);
    if (!connection || connection.userId !== auth.userId) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
    }

    return NextResponse.json({
      connection: {
        id: connection.id,
        providerId: connection.providerId,
        name: connection.name,
        status: connection.status,
        statusMessage: connection.statusMessage,
        visibility: connection.visibility,
        accountMetadata: connection.accountMetadata,
        baseUrlOverride: connection.baseUrlOverride,
        configOverrides: connection.configOverrides,
        lastUsedAt: connection.lastUsedAt,
        createdAt: connection.createdAt,
      },
    });
  } catch (error) {
    loggers.api.error('Error fetching user integration:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch integration' }, { status: 500 });
  }
}

/**
 * PATCH /api/user/integrations/[connectionId]
 * Update a user integration connection.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ connectionId: string }> }
) {
  const { connectionId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  try {
    const connection = await getConnectionById(db, connectionId);
    if (!connection || connection.userId !== auth.userId) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
    }

    const body = await request.json();
    const validation = patchConnectionSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const updateData: Record<string, unknown> = {};
    if (validation.data.name !== undefined) updateData.name = validation.data.name;
    if (validation.data.visibility !== undefined) updateData.visibility = validation.data.visibility;
    if (validation.data.configOverrides !== undefined) updateData.configOverrides = validation.data.configOverrides;

    const [updated] = await db
      .update(integrationConnections)
      .set(updateData)
      .where(eq(integrationConnections.id, connectionId))
      .returning();

    return NextResponse.json({
      connection: {
        id: updated.id,
        name: updated.name,
        visibility: updated.visibility,
        configOverrides: updated.configOverrides,
      },
    });
  } catch (error) {
    loggers.api.error('Error updating user integration:', error as Error);
    return NextResponse.json({ error: 'Failed to update integration' }, { status: 500 });
  }
}

/**
 * DELETE /api/user/integrations/[connectionId]
 * Delete a user integration connection. Cascades to grants.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ connectionId: string }> }
) {
  const { connectionId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  try {
    const connection = await getConnectionById(db, connectionId);
    if (!connection || connection.userId !== auth.userId) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
    }

    await deleteConnection(db, connectionId);
    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting user integration:', error as Error);
    return NextResponse.json({ error: 'Failed to delete integration' }, { status: 500 });
  }
}
