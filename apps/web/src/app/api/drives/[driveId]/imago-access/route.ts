import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getImagoDriveAccess, setImagoDriveAccess } from '@pagespace/lib/agents/imago-drive-access';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
// requireCSRF also turns on the Origin check for session requests.
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const putBodySchema = z.object({ enabled: z.boolean() }).strict();

/**
 * GET /api/drives/{driveId}/imago-access
 * The session viewer's Imago access to the drive: whether their Imago agents
 * are members of it, per agent. Drive owners and admins only.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> },
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const { driveId } = await context.params;

    const result = await getImagoDriveAccess(userId, driveId);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'drive', resourceId: driveId, details: { imagoAccess: result.access.enabled } });

    return NextResponse.json(result.access);
  } catch (error) {
    loggers.api.error('Error reading Imago access:', error as Error);
    return NextResponse.json({ error: 'Failed to read Imago access' }, { status: 500 });
  }
}

/**
 * PUT /api/drives/{driveId}/imago-access  { enabled: boolean }
 * Turn the session viewer's Imago access to the drive on (their Imago agents
 * join it as MEMBER) or off (they leave it). Drive owners and admins only;
 * Home is refused. Returns the new state.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ driveId: string }> },
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const { driveId } = await context.params;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const parsed = putBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.flatten().fieldErrors }, { status: 400 });
    }
    const { enabled } = parsed.data;

    const result = await setImagoDriveAccess(userId, driveId, enabled);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    auditRequest(request, {
      eventType: enabled ? 'authz.permission.granted' : 'authz.permission.revoked',
      userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { imagoAccess: enabled, agentPageIds: result.access.agents.map((agent) => agent.agentPageId) },
    });

    return NextResponse.json(result.access);
  } catch (error) {
    loggers.api.error('Error setting Imago access:', error as Error);
    return NextResponse.json({ error: 'Failed to set Imago access' }, { status: 500 });
  }
}
