import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { pageReorderService } from '@/services/api';
import { authenticateRequestWithOptions, checkMCPPageScope } from '@/lib/auth/request-auth';
import { isAuthError, isMCPAuthResult } from '@/lib/auth/auth-core';
import { isScopedMCPAuth, isPrincipalDriveOwnerOrAdmin } from '@/lib/auth/principal-permissions';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const reorderSchema = z.object({
  pageId: z.string(),
  newParentId: z.string().nullable(),
  newPosition: z.number().finite(),
});

export async function PATCH(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  try {
    const body = await request.json();
    const { pageId, newParentId, newPosition } = reorderSchema.parse(body);

    // Check MCP token scope before page access
    const scopeError = await checkMCPPageScope(auth, pageId);
    if (scopeError) return scopeError;

    // A scoped MCP token is its own drive member: it must hold OWNER/ADMIN on the
    // page's drive itself (mirrors the owner/admin rule pageReorderService enforces
    // for users), so a MEMBER-role token cannot reorder via its owner's powers.
    if (isScopedMCPAuth(auth)) {
      const page = await db.query.pages.findFirst({
        where: eq(pages.id, pageId),
        columns: { driveId: true },
      });
      if (!page) {
        return NextResponse.json({ error: 'Page not found.' }, { status: 404 });
      }
      if (!(await isPrincipalDriveOwnerOrAdmin(auth, page.driveId))) {
        return NextResponse.json(
          { error: 'Only drive owners and admins can reorder pages.' },
          { status: 403 }
        );
      }
    }

    // Validate parent change to prevent circular references
    const validation = await pageReorderService.validateMove(pageId, newParentId);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error },
        { status: 400 }
      );
    }

    // Execute the reorder operation
    const isMCP = isMCPAuthResult(auth);
    const result = await pageReorderService.reorderPage({
      pageId,
      newParentId,
      newPosition,
      userId: auth.userId,
      metadata: isMCP ? { source: 'mcp' } : undefined,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    await broadcastPageEvent(
      createPageEventPayload(result.driveId, pageId, 'moved', {
        parentId: newParentId,
        title: result.pageTitle || undefined,
      }),
    );

    auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'page', resourceId: pageId, details: { operation: 'reorder' } });

    return NextResponse.json({ message: 'Page reordered successfully' });
  } catch (error) {
    loggers.api.error('Error reordering page:', error as Error);

    // Handle Zod validation errors
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message || 'Validation failed' }, { status: 400 });
    }

    const errorMessage = error instanceof Error ? error.message : 'Failed to reorder page';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
