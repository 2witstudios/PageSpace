import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { canUserEditPage } from '@pagespace/lib/permissions';
import { getGrantById, updateGrant, deleteGrant } from '@pagespace/lib/integrations';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const updateGrantSchema = z.object({
  allowedTools: z.array(z.string()).nullable().optional(),
  deniedTools: z.array(z.string()).nullable().optional(),
  readOnly: z.boolean().optional(),
  rateLimitOverride: z.object({
    requestsPerMinute: z.number().min(1).max(1000).optional(),
  }).nullable().optional(),
});

/**
 * PUT /api/agents/[agentId]/integrations/[grantId]
 * Update an integration grant's tool permissions.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ agentId: string; grantId: string }> }
) {
  const { agentId, grantId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  try {
    const canEdit = await canUserEditPage(auth.userId, agentId);
    if (!canEdit) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const grant = await getGrantById(db, grantId);
    if (!grant || grant.agentId !== agentId) {
      return NextResponse.json({ error: 'Grant not found' }, { status: 404 });
    }

    const body = await request.json();
    const validation = updateGrantSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const updated = await updateGrant(db, grantId, validation.data);
    return NextResponse.json({ grant: updated });
  } catch (error) {
    loggers.api.error('Error updating agent integration grant:', error as Error);
    return NextResponse.json({ error: 'Failed to update grant' }, { status: 500 });
  }
}

/**
 * DELETE /api/agents/[agentId]/integrations/[grantId]
 * Remove an integration grant.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ agentId: string; grantId: string }> }
) {
  const { agentId, grantId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  try {
    const canEdit = await canUserEditPage(auth.userId, agentId);
    if (!canEdit) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const grant = await getGrantById(db, grantId);
    if (!grant || grant.agentId !== agentId) {
      return NextResponse.json({ error: 'Grant not found' }, { status: 404 });
    }

    await deleteGrant(db, grantId);
    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting agent integration grant:', error as Error);
    return NextResponse.json({ error: 'Failed to delete grant' }, { status: 500 });
  }
}
