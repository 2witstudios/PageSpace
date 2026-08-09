import { NextResponse } from 'next/server';
import { z } from "zod/v4";
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { kickForPagePermissionRevocation } from '@pagespace/lib/permissions/revocation-kick';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { trackPageOperation } from '@pagespace/lib/monitoring/activity-tracker';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope, isMCPAuthResult, canPrincipalSharePage, canPrincipalViewPage, canPrincipalEditPage, canPrincipalDeletePage } from '@/lib/auth';
import { jsonResponse } from '@pagespace/lib/utils/api-utils';
import { pageService } from '@/services/api';
import { db } from '@pagespace/db/db';
import { and, eq, isNotNull, ne, not, exists, or, isNull, gt, inArray, sql } from '@pagespace/db/operators';
import { pages, drives } from '@pagespace/db/schema/core';
import { driveMembers, pagePermissions, driveRoles } from '@pagespace/db/schema/members';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) {
    return auth.error;
  }

  // Check MCP token scope before page access
  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const userId = auth.userId;

  try {
    // Scoped MCP tokens authorize with their OWN drive-membership role.
    const result = await pageService.getPage(pageId, userId, {
      authorizeView: (id) => canPrincipalViewPage(auth, id),
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    auditRequest(req, { eventType: 'data.read', userId, resourceType: 'page', resourceId: pageId, details: { operation: 'read' } });

    return jsonResponse(result.page);
  } catch (error) {
    loggers.api.error('Error fetching page details:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch page details' }, { status: 500 });
  }
}

const patchSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  aiProvider: z.string().optional(),
  aiModel: z.string().optional(),
  parentId: z.string().nullable().optional(),
  isPaginated: z.boolean().optional(),
  isPrivate: z.boolean().optional(),
  expectedRevision: z.number().int().min(0).optional(),
  changeGroupId: z.string().optional(), // Groups related edits in activity log
});

export async function PATCH(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) {
    return auth.error;
  }

  // Check MCP token scope before page access
  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const userId = auth.userId;

  try {
    const body = await req.json();
    const safeBody = patchSchema.parse(body);
    const { expectedRevision, changeGroupId, isPrivate: isPrivateUpdate, ...contentUpdates } = safeBody;

    // isPrivate is a visibility-level change — requires share permission, NOT edit permission.
    // Apply it through the service with skipPermissionCheck so users with canShare but not
    // canEdit (e.g. page creator) can still toggle privacy.
    if (isPrivateUpdate !== undefined) {
      const canShare = await canPrincipalSharePage(auth, pageId);
      if (!canShare) {
        return NextResponse.json({ error: 'Only page owners and drive admins can change page visibility' }, { status: 403 });
      }
    }

    const isMCP = isMCPAuthResult(auth);
    const mcpMeta = isMCP ? { source: 'mcp' as const } : undefined;
    const context = (changeGroupId || mcpMeta)
      ? { changeGroupId, metadata: mcpMeta }
      : undefined;

    // Capture current isPrivate before the update so we can detect false→true transitions
    let previousIsPrivate: boolean | undefined;
    if (isPrivateUpdate !== undefined) {
      const currentPage = await db.query.pages.findFirst({
        where: eq(pages.id, pageId),
        columns: { isPrivate: true },
      });
      previousIsPrivate = currentPage?.isPrivate;
    }

    // Build the full updates object, applying isPrivate with skipPermissionCheck when present
    const updates = isPrivateUpdate !== undefined
      ? { ...contentUpdates, isPrivate: isPrivateUpdate }
      : contentUpdates;

    const result = await pageService.updatePage(pageId, userId, updates, {
      expectedRevision,
      context,
      skipPermissionCheck: isPrivateUpdate !== undefined && Object.keys(contentUpdates).length === 0,
      // Scoped MCP tokens authorize with their OWN drive-membership role.
      authorizeEdit: (id) => canPrincipalEditPage(auth, id),
    });

    if (!result.success) {
      return NextResponse.json(
        {
          error: result.error,
          currentRevision: result.currentRevision,
          expectedRevision: result.expectedRevision,
        },
        { status: result.status }
      );
    }

    // Side effects: broadcast
    const driveId = result.driveId;
    const socketId = req.headers.get('X-Socket-ID') || undefined;

    // Broadcast title update (affects tree structure)
    if (safeBody.title) {
      await broadcastPageEvent(
        createPageEventPayload(driveId, pageId, 'updated', {
          title: safeBody.title,
          parentId: result.page.parentId ?? undefined,
          socketId
        })
      );

    }

    // Broadcast content update (for document synchronization)
    if (safeBody.content) {
      await broadcastPageEvent(
        createPageEventPayload(driveId, pageId, 'content-updated', {
          title: result.page.title ?? undefined,
          parentId: result.page.parentId ?? undefined,
          socketId
        })
      );
    }

    // Instant revocation: kick members who lose implicit access when page becomes private
    if (isPrivateUpdate === true && previousIsPrivate === false) {
      const drive = await db.query.drives.findFirst({
        where: eq(drives.id, result.driveId),
        columns: { ownerId: true },
      });

      if (drive) {
        const membersLosingAccess: { userId: string }[] = await db
          .select({ userId: driveMembers.userId })
          .from(driveMembers)
          .where(and(
            eq(driveMembers.driveId, result.driveId),
            isNotNull(driveMembers.acceptedAt),
            ne(driveMembers.userId, drive.ownerId),
            not(inArray(driveMembers.role, ['OWNER', 'ADMIN'])),
            not(exists(
              db.select({ id: pagePermissions.id })
                .from(pagePermissions)
                .where(and(
                  eq(pagePermissions.pageId, pageId),
                  eq(pagePermissions.userId, driveMembers.userId),
                  eq(pagePermissions.canView, true),
                  or(isNull(pagePermissions.expiresAt), gt(pagePermissions.expiresAt, new Date()))
                ))
            )),
            not(exists(
              db.select({ id: driveRoles.id })
                .from(driveRoles)
                .where(and(
                  eq(driveRoles.id, driveMembers.customRoleId),
                  sql`${driveRoles.permissions} -> ${pageId} ->> 'canView' = 'true'`
                ))
            ))
          ));

        await Promise.all(
          membersLosingAccess.map(({ userId: memberId }) =>
            kickForPagePermissionRevocation({ userId: memberId, pageId, reason: 'page_private' })
          )
        );
      }
    }

    // Broadcast privacy change so connected clients revalidate their tree
    if (isPrivateUpdate !== undefined) {
      await broadcastPageEvent(
        createPageEventPayload(result.driveId, pageId, 'updated', {
          isPrivate: isPrivateUpdate,
          socketId,
        })
      );
    }

    // Track page update
    trackPageOperation(userId, 'update', pageId, {
      updatedFields: result.updatedFields,
      hasContentUpdate: !!safeBody.content,
      hasTitleUpdate: !!safeBody.title
    });

    auditRequest(req, { eventType: 'data.write', userId, resourceType: 'page', resourceId: pageId, details: { operation: 'update' } });

    return jsonResponse(result.page);
  } catch (error) {
    loggers.api.error('Error updating page:', error as Error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to update page' }, { status: 500 });
  }
}

const deleteSchema = z.object({
  trash_children: z.boolean().optional(),
}).nullable();

export async function DELETE(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) {
    return auth.error;
  }

  // Check MCP token scope before page access
  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const userId = auth.userId;

  try {
    // Safely parse JSON body - handle empty or malformed bodies
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {
      // Empty or invalid JSON body - use null which schema allows
      body = null;
    }
    const parsedBody = deleteSchema.parse(body);
    const trashChildren = parsedBody?.trash_children ?? true;

    const isMCP = isMCPAuthResult(auth);
    const result = await pageService.trashPage(pageId, userId, {
      trashChildren,
      metadata: isMCP ? { source: 'mcp' } : undefined,
      // Scoped MCP tokens authorize with their OWN drive-membership role.
      authorizeDelete: (id) => canPrincipalDeletePage(auth, id),
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // Side effects: broadcast
    await broadcastPageEvent(
      createPageEventPayload(result.driveId, pageId, 'trashed', {
        title: result.pageTitle ?? undefined,
        parentId: result.parentId ?? undefined
      })
    );

    // Track page deletion/trash
    trackPageOperation(userId, 'trash', pageId, {
      trashChildren: trashChildren,
      pageTitle: result.pageTitle,
      pageType: result.pageType
    });

    auditRequest(req, { eventType: 'data.delete', userId, resourceType: 'page', resourceId: pageId, details: { operation: 'trash' } });

    return NextResponse.json({ message: 'Page moved to trash successfully.' });
  } catch (error) {
    loggers.api.error('Error deleting page:', error as Error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to delete page' }, { status: 500 });
  }
}
