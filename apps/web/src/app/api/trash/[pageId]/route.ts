import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, sql } from '@pagespace/db/operators'
import { pages, favorites, pageTags } from '@pagespace/db/schema/core'
import { pagePermissions } from '@pagespace/db/schema/members'
import { channelMessages } from '@pagespace/db/schema/chat';
import { deleteConversationsForPages, type DbHandle } from '@pagespace/lib/repositories/conversation-cleanup';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserDeletePage } from '@pagespace/lib/permissions/permissions';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getActorInfo, logPageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { reapOrphanedFiles } from '@/lib/storage/reap-orphaned-files';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

// Note: taskItems linked to this page are automatically deleted via FK cascade (onDelete: 'cascade')
// `tx` is a TRANSACTION handle, not `typeof db`: this walks a subtree issuing
// many deletes that only make sense together, and `deleteConversationsForPages`
// below states the same requirement. Typed loosely, the recursion was a hole
// one level above the helper's own guard.
async function recursivelyDelete(pageId: string, tx: DbHandle) {
    const children = await tx.select({ id: pages.id }).from(pages).where(eq(pages.parentId, pageId));

    for (const child of children) {
        await recursivelyDelete(child.id, tx);
    }

    await tx.delete(pagePermissions).where(eq(pagePermissions.pageId, pageId));
    await tx.delete(favorites).where(eq(favorites.pageId, pageId));
    await tx.delete(pageTags).where(eq(pageTags.pageId, pageId));

    // Permanent delete of a page must take its chat history with it (epic
    // "Agent-Session Single Source of Truth", Phase 4 / D6). Explicit, because
    // nothing else would do it: `conversations.contextId` has never been a
    // foreign key, `conversations.agentPageId`'s is ON DELETE SET NULL, and
    // the `chat_messages.pageId` cascade that used to cover this went with the
    // table at PR 15. Without this a permanently deleted page's chat history
    // would outlive it, still readable by conversation id.
    //
    // Called BEFORE the `pages` delete below, which is what clears
    // `agentPageId`. This statement used to be written inline here, which is
    // why every OTHER deletion path — the cron purge and all four drive-delete
    // sites — silently under-deleted; it now lives in one shared helper they
    // all call. Recursion above means this node's own id is the whole scope.
    await deleteConversationsForPages(tx, [pageId]);

    await tx.delete(channelMessages).where(eq(channelMessages.pageId, pageId));

    await tx.delete(pages).where(eq(pages.id, pageId));
}

// Collect the file IDs a page subtree references — via file_pages links or via a
// page's filePath matching a file's storagePath — BEFORE the page rows (and their
// cascading file_pages links) are deleted. Reaping is then scoped to just these
// files instead of sweeping the whole files table inside the request.
async function collectSubtreeFileIds(rootPageId: string): Promise<string[]> {
  const result = await db.execute(sql`
    WITH RECURSIVE subtree AS (
      SELECT id, "filePath" FROM pages WHERE id = ${rootPageId}
      UNION ALL
      SELECT p.id, p."filePath" FROM pages p JOIN subtree s ON p."parentId" = s.id
    )
    SELECT DISTINCT f.id
    FROM files f
    WHERE f.id IN (SELECT fp."fileId" FROM file_pages fp JOIN subtree s ON fp."pageId" = s.id)
       OR f."storagePath" IN (SELECT "filePath" FROM subtree WHERE "filePath" IS NOT NULL)
  `);
  return (result.rows as Array<{ id: string }>).map(row => row.id);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const canDelete = await canUserDeletePage(userId, pageId);
  if (!canDelete) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  try {
    const page = await db.query.pages.findFirst({ where: eq(pages.id, pageId) });
    if (!page || !page.isTrashed) {
      return NextResponse.json({ error: 'Page is not in trash' }, { status: 400 });
    }

    // Capture page info before deletion for audit trail
    const pageTitle = page.title;
    const driveId = page.driveId;

    // Snapshot the files this subtree references BEFORE deleting — afterwards the
    // cascaded file_pages links are gone and the set can't be recovered.
    const candidateFileIds = await collectSubtreeFileIds(pageId);

    await db.transaction(async (tx) => {
      await recursivelyDelete(pageId, tx);
    });

    // Deleting the page rows cascades away their file_pages links, so any file
    // backing only these pages is now orphaned. Reap just those files inline so
    // the user's storage cap frees immediately rather than waiting for the weekly
    // cron — scoped by candidateFileIds so a backlog of unrelated orphans can't
    // make this request block. Best-effort: never fail the delete if reaping
    // hiccups, and skip the scan entirely when the subtree had no files.
    if (candidateFileIds.length > 0) {
      try {
        const reaped = await reapOrphanedFiles(db, { fileIds: candidateFileIds });
        if (reaped.dbRecordsDeleted > 0) {
          loggers.api.info(`Permanent delete reaped ${reaped.dbRecordsDeleted} orphaned file(s)`, { pageId });
        }
      } catch (error) {
        loggers.api.warn('Inline orphan reap after permanent delete failed; weekly cron will retry', { pageId, error: error as Error });
      }
    }

    // Log permanent deletion for compliance (fire-and-forget)
    const actorInfo = await getActorInfo(userId);
    logPageActivity(userId, 'delete', {
      id: pageId,
      title: pageTitle,
      driveId,
    }, actorInfo);

    auditRequest(req, { eventType: 'data.delete', userId, resourceType: 'page', resourceId: pageId, details: { driveId, source: 'trash' } });

    return NextResponse.json({ message: 'Page permanently deleted.' });
  } catch (error) {
    loggers.api.error('Error permanently deleting page:', error as Error);
    return NextResponse.json({ error: 'Failed to permanently delete page' }, { status: 500 });
  }
}