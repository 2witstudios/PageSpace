import { NextResponse } from 'next/server';
import { publishHomePageAtRoot, PublishError } from '@/lib/canvas/publish-page';
import { isPublishConfigured } from '@/lib/canvas/published-storage';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError, checkMCPDriveScope } from '@/lib/auth/auth-core';
import { isPrincipalDriveOwnerOrAdmin } from '@/lib/auth/principal-permissions';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

/**
 * POST /api/drives/[driveId]/publish-home
 *
 * Manually (re)publish the drive's home page at the subdomain root path.
 * Useful after content changes or to recover from a failed auto-publish.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ driveId: string }> },
) {
  const { driveId } = await params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const scopeError = checkMCPDriveScope(auth, driveId);
  if (scopeError) return scopeError;

  const userId = auth.userId;

  if (!(await isPrincipalDriveOwnerOrAdmin(auth, driveId))) {
    return NextResponse.json(
      { error: 'Only drive owners and admins can publish the home page' },
      { status: 403 },
    );
  }

  // Operational kill-switch: mirror the per-page publish endpoint so this route
  // can't be used to bypass a global publishing freeze.
  if (process.env.CANVAS_PUBLISHING_DISABLED === 'true') {
    return NextResponse.json(
      { error: 'Publishing is temporarily disabled' },
      { status: 503 },
    );
  }

  if (!isPublishConfigured()) {
    return NextResponse.json(
      { error: 'Publishing is not configured' },
      { status: 503 },
    );
  }

  try {
    const result = await publishHomePageAtRoot(driveId, userId);

    if (!result) {
      return NextResponse.json(
        { error: 'Drive has no canvas home page or no publish subdomain. Set a canvas page as the home page first.' },
        { status: 400 },
      );
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'drive',
      resourceId: driveId,
      details: { operation: 'publish-home' },
    });

    return NextResponse.json(result);
  } catch (error) {
    loggers.api.error('Error publishing home page:', error as Error);
    const message = error instanceof Error ? error.message : 'Failed to publish home page';
    const statusCode = error instanceof PublishError ? error.statusCode : 500;
    return NextResponse.json({ error: message }, { status: statusCode });
  }
}
