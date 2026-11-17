import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db } from '@pagespace/db/db'
import { and, eq, inArray, desc, isNull } from '@pagespace/db/operators'
import { pages, drives } from '@pagespace/db/schema/core'
import { isSheetType } from '@pagespace/lib/sheets/sheet';
import { copySheetRows } from '@pagespace/lib/sheets/store';
import { PageType } from '@pagespace/lib/utils/enums';
import { driveRoleOf } from '@pagespace/lib/permissions/drive-relationship';
import { loadDriveRelationship } from '@pagespace/lib/permissions/drive-relationship-loader';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, getAllowedDriveIds, isMCPAuthResult, isScopedMCPAuth, canPrincipalViewPage } from '@/lib/auth';
import { getAppDriveMembership } from '@pagespace/lib/permissions/app-permissions';
import { createId } from '@paralleldrive/cuid2';
import { getActorInfo, logPageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { createChangeGroupId } from '@pagespace/lib/monitoring/change-group';
import { ensureTaskItemForPage } from '@/services/api/task-sync-service';
import { OrgLapsedError, checkDriveMayLoosen, isOrgLapsedError } from '@pagespace/lib/permissions/org-lapse-guard';
import { orgLapsedResponse } from '@/lib/orgs/org-lapsed-response';
import { assertAgentModelAllowed, orgModelPolicyErrorResponse } from '@/services/api/page-mutation-service';
import { actorFromAuth, deniedResponse } from '@/lib/auth/request-actor';
import { findBlockedUploads } from '@pagespace/lib/content-safety/upload-gate';
import { contentCopyRefusedResponse } from '@/lib/upload/content-blocked-response';
import { auditUnverifiableFileReference, loadFileStoragePaths, resolveStoredContentHash } from '@/lib/upload/stored-content-hash';
import { pageContentCanReferenceFiles, scanStoredFileReferences, type StoredFileReferenceScan } from '@/lib/upload/stored-file-references';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const requestSchema = z.object({
  pageIds: z.array(z.string()).min(1, 'At least one page ID is required'),
  targetDriveId: z.string().min(1, 'Target drive ID is required'),
  targetParentId: z.string().nullable(),
  includeChildren: z.boolean().default(true),
});

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    const body = await request.json();

    const parseResult = requestSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.issues.map(i => i.message).join('. ') },
        { status: 400 }
      );
    }

    const { pageIds, targetDriveId, targetParentId, includeChildren } = parseResult.data;

    // Verify target drive exists
    const targetDrive = await db.query.drives.findFirst({
      where: eq(drives.id, targetDriveId),
    });

    if (!targetDrive) {
      return NextResponse.json({ error: 'Target drive not found' }, { status: 404 });
    }

    // Check MCP token scope for target drive
    const targetScopeError = checkMCPDriveScope(auth, targetDriveId);
    if (targetScopeError) {
      return targetScopeError;
    }

    // Check the principal has edit access to target drive. A scoped MCP token
    // is its own drive member — use the TOKEN's role, not its owning user's.
    let canEditDrive: boolean;
    const tokenMembership = isScopedMCPAuth(auth)
      ? await getAppDriveMembership(actorFromAuth(auth), auth.tokenId, targetDriveId)
      : null;
    if (isScopedMCPAuth(auth) && tokenMembership?.role !== null) {
      // Explicit-role keys need OWNER/ADMIN; inherited keys (role null) fall
      // through to the owner's own authority below.
      canEditDrive = tokenMembership?.role === 'OWNER' || tokenMembership?.role === 'ADMIN';
    } else {
      // The drive's lead or an effective OWNER/ADMIN (the org-aware membership reads ACCEPTED rows
      // only, so a pending ADMIN invitee cannot write into a drive they have not joined).
      const role = driveRoleOf(await loadDriveRelationship(actorFromAuth(auth), targetDrive));
      canEditDrive = role === 'OWNER' || role === 'ADMIN';
    }

    if (!canEditDrive) {
      return NextResponse.json(
        { error: 'You do not have permission to copy pages to this drive' },
        { status: 403 }
      );
    }

    // Verify target parent exists if specified
    if (targetParentId) {
      const targetParent = await db.query.pages.findFirst({
        where: and(
          eq(pages.id, targetParentId),
          eq(pages.driveId, targetDriveId),
          eq(pages.isTrashed, false)
        ),
      });
      if (!targetParent) {
        return NextResponse.json({ error: 'Target folder not found' }, { status: 404 });
      }
    }

    // Fetch source pages
    // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
    const sourcePages = await db.query.pages.findMany({
      where: inArray(pages.id, pageIds),
    });

    if (sourcePages.length !== pageIds.length) {
      return NextResponse.json({ error: 'Some pages not found' }, { status: 404 });
    }

    // Check MCP token scope for all source pages
    const allowedDriveIds = getAllowedDriveIds(auth);
    if (allowedDriveIds.length > 0) {
      const allowedSet = new Set(allowedDriveIds);
      for (const page of sourcePages) {
        if (!allowedSet.has(page.driveId)) {
          return NextResponse.json(
            { error: 'This token does not have access to one or more source pages' },
            { status: 403 }
          );
        }
      }
    }

    // Verify view permissions for all pages
    for (const page of sourcePages) {
      const canView = await canPrincipalViewPage(auth, page.id);
      if (!canView) {
        return deniedResponse(actorFromAuth(auth), page.id, NextResponse.json(
          { error: `You do not have permission to copy page: ${page.title}` },
          { status: 403 }
        ));
      }
    }

    // Get the max position in target parent
    const lastPage = await db.query.pages.findFirst({
      where: and(
        eq(pages.driveId, targetDriveId),
        targetParentId ? eq(pages.parentId, targetParentId) : isNull(pages.parentId),
        eq(pages.isTrashed, false)
      ),
      orderBy: [desc(pages.position)],
    });

    // Content blocklist: a copy attaches each source file's bytes to a new page
    // without an upload, so it gets the upload gate — and so does every stored
    // file a copied document or canvas embeds by reference. The whole tree is
    // read and checked here with ONE blocklist query, before the transaction
    // opens; the transaction then copies only the pages this screen saw.
    const descendants = includeChildren ? await collectDescendants(sourcePages.map((p) => p.id)) : [];
    const screened = [...sourcePages, ...descendants];
    const screen = await screenCopy(screened, { request, userId, targetDriveId });
    if (screen.refusal) return screen.refusal;
    const screenedEmbeds = screen.embeddedIds;
    // Includes the selected pages themselves: one selected together with its
    // ancestor is also a child in that ancestor's copy. Keyed by id, holding the
    // file reference the screen checked, so the copy can tell a page whose
    // reference changed since from one it may copy.
    const screenedRefs: ScreenedRefs = new Map(screened.map((p) => [p.id, fileRefKey(p)]));

    let nextPosition = (lastPage?.position || 0) + 1;
    let copiedCount = 0;
    const copiedPages: Array<{ newId: string; sourceTitle: string | null; sourceId: string }> = [];

    // Copy pages in transaction
    await db.transaction(async (tx) => {
      // [D-OW-33] ruling P2-4: copying pages OUT of a lapsed org's drive puts its content where another drive's members
      // read it: refused, checked against each SOURCE drive in this transaction. A copy within the same drive is not
      // this. Exporting data (account / GDPR export) stays available.
      for (const sourceDriveId of new Set(sourcePages.map((p) => p.driveId))) {
        if (sourceDriveId !== targetDriveId && (await checkDriveMayLoosen(tx, sourceDriveId, true))) throw new OrgLapsedError();
      }
      for (const page of sourcePages) {
        await assertCopiedAgentModelAllowed(targetDriveId, page);
        const newPageId = createId();
        copiedPages.push({ newId: newPageId, sourceTitle: page.title, sourceId: page.id });

        // Copy the page
        await tx.insert(pages).values({
          id: newPageId,
          title: page.title ? `${page.title} (Copy)` : 'Untitled (Copy)',
          type: page.type,
          content: page.content,
          driveId: targetDriveId,
          parentId: targetParentId,
          position: nextPosition,
          createdAt: new Date(),
          updatedAt: new Date(),
          revision: 0,
          stateHash: null,
          isTrashed: false,
          aiProvider: page.aiProvider,
          aiModel: page.aiModel,
          systemPrompt: page.systemPrompt,
          enabledTools: page.enabledTools,
          isPaginated: page.isPaginated,
          // AI chat settings
          includeDrivePrompt: page.includeDrivePrompt,
          agentDefinition: page.agentDefinition,
          visibleToGlobalAssistant: page.visibleToGlobalAssistant,
          includePageTree: page.includePageTree,
          pageTreeScope: page.pageTreeScope,
          // File-specific fields
          fileSize: page.fileSize,
          mimeType: page.mimeType,
          originalFileName: page.originalFileName,
          filePath: page.filePath,
          fileMetadata: page.fileMetadata,
          // Processing status fields - reset so copies are reprocessed independently
          processingStatus: page.type === 'FILE' ? 'pending' : null,
          processingError: null,
          processedAt: null,
          extractionMethod: page.extractionMethod,
          extractionMetadata: page.extractionMetadata,
          contentHash: page.contentHash,
        });

        // A sheet's cells live in rows; `content` is empty for a materialised
        // one, so copying the column alone produced a blank spreadsheet.
        if (isSheetType(page.type as PageType)) {
          await copySheetRows(page.id, newPageId, tx);
        }

        // A TASK_LIST copied under a TASK_LIST parent must appear as a task.
        await ensureTaskItemForPage(tx, {
          pageId: newPageId,
          pageType: page.type,
          parentId: targetParentId,
          userId,
        });

        copiedCount += 1;
        nextPosition += 1;

        // Recursively copy children if requested
        if (includeChildren) {
          const childCount = await copyChildrenRecursively(
            tx,
            page.id,
            newPageId,
            targetDriveId,
            userId,
            screenedRefs,
            screenedEmbeds
          );
          copiedCount += childCount;
        }
      }
    });

    // Log activity for each top-level copied page (children are covered by the parent entry's totalPages count)
    const actorInfo = await getActorInfo(userId);
    const isMCP = isMCPAuthResult(auth);
    const changeGroupId = createChangeGroupId();
    for (const copied of copiedPages) {
      logPageActivity(userId, 'create', {
        id: copied.newId,
        title: copied.sourceTitle ? `${copied.sourceTitle} (Copy)` : 'Untitled (Copy)',
        driveId: targetDriveId,
      }, {
        ...actorInfo,
        changeGroupId,
        changeGroupType: 'user',
        metadata: {
          bulkOperation: 'copy',
          sourcePageId: copied.sourceId,
          totalPages: copiedCount,
          includeChildren,
          ...(isMCP && { source: 'mcp' }),
        },
      });
    }

    await broadcastPageEvent(
      createPageEventPayload(targetDriveId, '', 'created')
    );

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'page', resourceId: 'bulk', details: { operation: 'bulk_copy', count: copiedCount } });

    return NextResponse.json({
      success: true,
      copiedCount,
    });
  } catch (error) {
    if (error instanceof CopyReferenceChangedError) {
      return NextResponse.json(
        { error: 'Some pages changed while they were being copied. Please try again.' },
        { status: 409 }
      );
    }
    if (isOrgLapsedError(error)) return orgLapsedResponse();
    const refused = orgModelPolicyErrorResponse(error);
    if (refused) return NextResponse.json(refused.body, { status: refused.status });
    loggers.api.error('Error bulk copying pages:', error as Error);
    return NextResponse.json(
      { error: 'Failed to copy pages' },
      { status: 500 }
    );
  }
}

/**
 * POL-8: a copied agent page stores its provider/model in the target drive, which is a save there: refused (and the
 * whole copy rolled back) when the target drive's org does not allow it.
 */
async function assertCopiedAgentModelAllowed(targetDriveId: string, page: { type: string; aiProvider: string | null; aiModel: string | null }): Promise<void> {
  if (page.type !== PageType.AI_CHAT) return;
  await assertAgentModelAllowed(targetDriveId, { provider: page.aiProvider, modelId: page.aiModel });
}

interface CopyGate {
  request: Request;
  userId: string;
  targetDriveId: string;
}

interface CopyScreenRow {
  id: string;
  type: string;
  content: string;
  contentHash: string | null;
  filePath: string | null;
}

/**
 * The stored files a copied page's content embeds; none for types that can't
 * embed. `complete` is false when the content mentions `api/files/` in a form
 * the scan can't account for: the page is then unverifiable.
 */
function embeddedFiles(row: Pick<CopyScreenRow, 'type' | 'content'>): StoredFileReferenceScan {
  return pageContentCanReferenceFiles(row.type) && row.content
    ? scanStoredFileReferences(row.content)
    : { ids: [], complete: true };
}

/** Page id → the file reference the blocklist screen checked for it. */
type ScreenedRefs = ReadonlyMap<string, string>;

function fileRefKey(row: Pick<CopyScreenRow, 'contentHash' | 'filePath'>): string {
  return JSON.stringify([row.filePath, row.contentHash]);
}

/**
 * A screened page's `filePath` or `contentHash` changed between the screen and
 * the transaction's read, so what would be copied is not what was checked.
 * Thrown inside the transaction: the whole copy rolls back.
 */
class CopyReferenceChangedError extends Error {
  constructor(pageId: string) {
    super(`Page ${pageId} changed its file reference during the copy`);
    this.name = 'CopyReferenceChangedError';
  }
}

/**
 * Every non-trashed descendant of `rootIds`, one query per tree level, read
 * before the copy transaction opens. The `seen` set ends THIS walk on a parent
 * cycle; the copy's own recursion has no such guard (as before this screen).
 */
async function collectDescendants(rootIds: readonly string[]): Promise<CopyScreenRow[]> {
  const seen = new Set(rootIds);
  const descendants: CopyScreenRow[] = [];
  let level = [...rootIds];
  while (level.length > 0) {
    // eslint-disable-next-line no-restricted-syntax -- bounded by the copied tree; mirrors the copy's own unbounded child read
    const children: CopyScreenRow[] = await db.query.pages.findMany({
      where: and(inArray(pages.parentId, level), eq(pages.isTrashed, false)),
      columns: { id: true, type: true, content: true, contentHash: true, filePath: true },
    });
    const fresh = children.filter((child) => !seen.has(child.id));
    for (const child of fresh) seen.add(child.id);
    descendants.push(...fresh);
    level = fresh.map((child) => child.id);
  }
  return descendants;
}

/**
 * Refuse the whole copy (neutral 422, nothing written) when any page in it
 *   - carries a content hash on the blocklist,
 *   - has a `filePath` that can't be resolved to a content hash, so its bytes
 *     can't be checked at all (fail closed), or
 *   - is a DOCUMENT or CANVAS whose content embeds a stored file
 *     (`/api/files/{id}/view` and the like) that is blocked or whose bytes can't
 *     be resolved to a hash, or that mentions `api/files/` in a form the
 *     reference scan can't account for (fail closed). An embedded id that matches no page and no `files`
 *     row is skipped: nothing is stored under it, so nothing can be served.
 * One blocklist query for the whole tree. Blocked hashes are audited by the
 * gate; unverifiable references are audited here.
 *
 * Returns every embedded id it screened, so the copy can tell a reference added
 * to a page's content after the screen from one it checked.
 */
async function screenCopy(
  rows: readonly CopyScreenRow[],
  gate: CopyGate,
): Promise<{ refusal: NextResponse | null; embeddedIds: ReadonlySet<string> }> {
  const hashes = new Set<string>();
  let unverifiable = false;
  const auditUnverifiable = (resourceType: 'page' | 'file', resourceId: string, extra: Record<string, unknown> = {}) => {
    unverifiable = true;
    auditUnverifiableFileReference({
      request: gate.request,
      userId: gate.userId,
      entryPoint: 'page.copy',
      resourceType,
      resourceId,
      details: { driveId: gate.targetDriveId, ...extra },
    });
  };

  // id of an embedded reference → the copied page that embeds it (first seen).
  const embeddedBy = new Map<string, string>();
  for (const row of rows) {
    addFileRefHashes(row, hashes, () => auditUnverifiable('page', row.id));
    const embedded = embeddedFiles(row);
    if (!embedded.complete) auditUnverifiable('page', row.id, { unaccountedReference: true });
    for (const id of embedded.ids) {
      if (!embeddedBy.has(id)) embeddedBy.set(id, row.id);
    }
  }

  if (embeddedBy.size > 0) {
    const ids = [...embeddedBy.keys()];
    // eslint-disable-next-line no-restricted-syntax -- bounded by the references in the copied tree
    const pageRows: Array<Pick<CopyScreenRow, 'id' | 'contentHash' | 'filePath'>> = await db.query.pages.findMany({
      where: inArray(pages.id, ids),
      columns: { id: true, contentHash: true, filePath: true },
    });
    const pagesById = new Map(pageRows.map((row) => [row.id, row]));
    const storagePaths = await loadFileStoragePaths(ids.filter((id) => !pagesById.has(id)));
    for (const id of ids) {
      const extra = { pageId: embeddedBy.get(id) };
      const page = pagesById.get(id);
      if (page) {
        addFileRefHashes(page, hashes, () => auditUnverifiable('file', id, extra));
        continue;
      }
      if (storagePaths.has(id)) {
        const hash = resolveStoredContentHash(storagePaths.get(id) || id);
        if (hash) hashes.add(hash);
        else auditUnverifiable('file', id, extra);
        continue;
      }
      // No row at all. An id that is itself a content hash is still checked:
      // it names the bytes directly.
      const direct = resolveStoredContentHash(id);
      if (direct) hashes.add(direct);
    }
  }

  const blocked = hashes.size === 0
    ? hashes
    : await findBlockedUploads([...hashes], {
        entryPoint: 'page.copy',
        userId: gate.userId,
        request: gate.request,
        details: { driveId: gate.targetDriveId },
      });
  return {
    refusal: blocked.size > 0 || unverifiable ? contentCopyRefusedResponse() : null,
    embeddedIds: new Set(embeddedBy.keys()),
  };
}

/**
 * Add the hashes a page row's own file columns point at. `filePath` is what the
 * file readers serve from, in bare or legacy `files/<hash>/original` form;
 * `contentHash` is checked too when it is one. A `filePath` that resolves to no
 * hash calls `onUnverifiable`.
 */
function addFileRefHashes(
  row: Pick<CopyScreenRow, 'contentHash' | 'filePath'>,
  hashes: Set<string>,
  onUnverifiable: () => void,
): void {
  const fromPath = row.filePath ? resolveStoredContentHash(row.filePath) : null;
  const fromColumn = row.contentHash ? resolveStoredContentHash(row.contentHash) : null;
  if (fromPath) hashes.add(fromPath);
  if (fromColumn) hashes.add(fromColumn);
  if (row.filePath && !fromPath) onUnverifiable();
}

// Recursively copy children
async function copyChildrenRecursively(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  sourceParentId: string,
  newParentId: string,
  targetDriveId: string,
  userId: string,
  screenedRefs: ScreenedRefs,
  screenedEmbeds: ReadonlySet<string>
): Promise<number> {
  // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
  const allChildren = await tx.query.pages.findMany({
    where: and(
      eq(pages.parentId, sourceParentId),
      eq(pages.isTrashed, false)
    ),
  });
  // Only pages the blocklist screen saw are copied: one created or moved into
  // the tree after the screen ran was never checked, so it is left out. One the
  // screen saw whose file reference has changed since aborts the whole copy:
  // its new bytes were never checked, and dropping it would lose its subtree.
  const children = allChildren.filter((child) => {
    const screenedRef = screenedRefs.get(child.id);
    if (screenedRef === undefined) return false;
    if (screenedRef !== fileRefKey(child)) throw new CopyReferenceChangedError(child.id);
    // Text edits since the screen are fine; a stored file embedded since is not.
    const embedded = embeddedFiles(child);
    if (!embedded.complete || embedded.ids.some((id) => !screenedEmbeds.has(id))) throw new CopyReferenceChangedError(child.id);
    return true;
  });

  let copiedCount = 0;

  for (const child of children) {
    await assertCopiedAgentModelAllowed(targetDriveId, child);
    const newChildId = createId();

    await tx.insert(pages).values({
      id: newChildId,
      title: child.title,
      type: child.type,
      content: child.content,
      driveId: targetDriveId,
      parentId: newParentId,
      position: child.position,
      createdAt: new Date(),
      updatedAt: new Date(),
      revision: 0,
      stateHash: null,
      isTrashed: false,
      aiProvider: child.aiProvider,
      aiModel: child.aiModel,
      systemPrompt: child.systemPrompt,
      enabledTools: child.enabledTools,
      isPaginated: child.isPaginated,
      // AI chat settings
      includeDrivePrompt: child.includeDrivePrompt,
      agentDefinition: child.agentDefinition,
      visibleToGlobalAssistant: child.visibleToGlobalAssistant,
      includePageTree: child.includePageTree,
      pageTreeScope: child.pageTreeScope,
      // File-specific fields
      fileSize: child.fileSize,
      mimeType: child.mimeType,
      originalFileName: child.originalFileName,
      filePath: child.filePath,
      fileMetadata: child.fileMetadata,
      // Processing status fields - reset so copies are reprocessed independently
      processingStatus: child.type === 'FILE' ? 'pending' : null,
      processingError: null,
      processedAt: null,
      extractionMethod: child.extractionMethod,
      extractionMetadata: child.extractionMetadata,
      contentHash: child.contentHash,
    });

    if (isSheetType(child.type as PageType)) {
      await copySheetRows(child.id, newChildId, tx);
    }

    // A TASK_LIST copied under a TASK_LIST parent must appear as a task.
    await ensureTaskItemForPage(tx, {
      pageId: newChildId,
      pageType: child.type,
      parentId: newParentId,
      userId,
    });

    copiedCount += 1;

    // Recursively copy grandchildren
    const grandchildCount = await copyChildrenRecursively(
      tx,
      child.id,
      newChildId,
      targetDriveId,
      userId,
      screenedRefs,
      screenedEmbeds
    );
    copiedCount += grandchildCount;
  }

  return copiedCount;
}
