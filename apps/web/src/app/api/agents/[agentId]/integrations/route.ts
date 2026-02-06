import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { canUserEditPage } from '@pagespace/lib/permissions';
import {
  listGrantsByAgent,
  createGrant,
  getConnectionById,
  findGrant,
} from '@pagespace/lib/integrations';

const AUTH_OPTIONS_READ = { allow: ['session'] as const };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const createGrantSchema = z.object({
  connectionId: z.string().min(1),
  allowedTools: z.array(z.string()).nullable().optional().default(null),
  deniedTools: z.array(z.string()).nullable().optional().default(null),
  readOnly: z.boolean().optional().default(false),
  rateLimitOverride: z.object({
    requestsPerMinute: z.number().min(1).max(1000).optional(),
  }).nullable().optional(),
});

/**
 * GET /api/agents/[agentId]/integrations
 * List all integration grants for an agent.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  try {
    // Verify user can view the agent
    const canEdit = await canUserEditPage(auth.userId, agentId);
    if (!canEdit) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const grants = await listGrantsByAgent(db, agentId);

    return NextResponse.json({
      grants: grants.map((g) => ({
        id: g.id,
        agentId: g.agentId,
        connectionId: g.connectionId,
        allowedTools: g.allowedTools,
        deniedTools: g.deniedTools,
        readOnly: g.readOnly,
        rateLimitOverride: g.rateLimitOverride,
        createdAt: g.createdAt,
        connection: g.connection ? {
          id: g.connection.id,
          name: g.connection.name,
          status: g.connection.status,
          provider: g.connection.provider ? {
            slug: g.connection.provider.slug,
            name: g.connection.provider.name,
          } : null,
        } : null,
      })),
    });
  } catch (error) {
    loggers.api.error('Error listing agent integration grants:', error as Error);
    return NextResponse.json({ error: 'Failed to list grants' }, { status: 500 });
  }
}

/**
 * POST /api/agents/[agentId]/integrations
 * Create a new integration grant for an agent.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  try {
    const canEdit = await canUserEditPage(auth.userId, agentId);
    if (!canEdit) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const body = await request.json();
    const validation = createGrantSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { connectionId, allowedTools, deniedTools, readOnly, rateLimitOverride } = validation.data;

    // Verify connection exists and is active
    const connection = await getConnectionById(db, connectionId);
    if (!connection) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
    }
    if (connection.status !== 'active') {
      return NextResponse.json({ error: 'Connection is not active' }, { status: 400 });
    }

    // Check for existing grant
    const existing = await findGrant(db, agentId, connectionId);
    if (existing) {
      return NextResponse.json({ error: 'Grant already exists for this connection' }, { status: 409 });
    }

    const grant = await createGrant(db, {
      agentId,
      connectionId,
      allowedTools,
      deniedTools,
      readOnly,
      rateLimitOverride,
    });

    return NextResponse.json({ grant }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating agent integration grant:', error as Error);
    return NextResponse.json({ error: 'Failed to create grant' }, { status: 500 });
  }
}
