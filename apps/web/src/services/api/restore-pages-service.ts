import { eq, sql } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { isSheetType } from '@pagespace/lib/sheets/sheet';
import { replaceFromDocument } from '@pagespace/lib/sheets/store';
import { sheetTabs } from '@pagespace/db/schema/sheets';
import { PageType } from '@pagespace/lib/utils/enums';
import { readPageContent } from '@pagespace/lib/services/page-content-store';
import { createPageVersion, computePageStateHash } from '@pagespace/lib/services/page-version-service';
import type { ChangeGroupType } from '@pagespace/lib/monitoring/change-group';
import type { RestoreDiff, BackupPageRow } from './restore-diff-service';

export type PageRestoreOp =
  | { op: 'create'; pageId: string; title: string; type: string; parentId: string | null; position: number | null; contentRef: string | null; isTrashed: boolean; trashedAt: Date | null }
  | { op: 'overwrite'; pageId: string; title: string; type: string; parentId: string | null; position: number | null; contentRef: string | null; isTrashed: boolean; trashedAt: Date | null }
  | { op: 'soft-delete'; pageId: string };

export function planPageRestoreOps(
  diff: RestoreDiff,
  backupPageMap: Map<string, BackupPageRow>,
): PageRestoreOp[] {
  const ops: PageRestoreOp[] = [];

  for (const item of diff.toCreate) {
    const row = backupPageMap.get(item.pageId);
    if (!row) {
      throw new Error(`Invariant violation: pageId ${item.pageId} in toCreate not found in backupPageMap`);
    }
    ops.push({
      op: 'create',
      pageId: item.pageId,
      title: row.title ?? item.title,
      type: row.type ?? item.type,
      parentId: row.parentId ?? null,
      position: row.position ?? null,
      contentRef: row.contentRef ?? null,
      isTrashed: row.isTrashed,
      trashedAt: row.trashedAt ?? null,
    });
  }

  for (const item of diff.toOverwrite) {
    const row = backupPageMap.get(item.pageId);
    if (!row) {
      throw new Error(`Invariant violation: pageId ${item.pageId} in toOverwrite not found in backupPageMap`);
    }
    ops.push({
      op: 'overwrite',
      pageId: item.pageId,
      title: row.title ?? item.title,
      type: row.type ?? item.type,
      parentId: row.parentId ?? null,
      position: row.position ?? null,
      contentRef: row.contentRef ?? null,
      isTrashed: row.isTrashed,
      trashedAt: row.trashedAt ?? null,
    });
  }

  for (const item of diff.toOrphan) {
    ops.push({ op: 'soft-delete', pageId: item.pageId });
  }

  return ops;
}

type DbLike = {
  insert: (table: typeof pages) => { values: (values: Record<string, unknown>) => Promise<unknown> };
  update: (table: typeof pages) => { set: (values: Record<string, unknown>) => { where: (cond: unknown) => Promise<unknown> } };
  /** Needed to clear a sheet's rows when the restored document is empty. */
  delete: (table: typeof sheetTabs) => { where: (cond: unknown) => Promise<unknown> };
};

const CONTENT_CONCURRENCY = 10;

export async function applyPageRestoreOps(
  ops: PageRestoreOp[],
  driveId: string,
  userId: string,
  backupId: string,
  changeGroupId: string,
  changeGroupType: ChangeGroupType,
  tx: DbLike,
): Promise<void> {
  // Pre-fetch all S3 content before entering DB writes so the transaction loop
  // does not block on I/O.
  const contentCache = new Map<string, string>();
  /** Pages whose stored content could not be read. Never treated as empty. */
  const readFailed = new Set<string>();
  const opsNeedingContent = ops.filter(
    (op): op is Extract<PageRestoreOp, { op: 'create' | 'overwrite' }> => op.op !== 'soft-delete',
  );
  const queue = [...opsNeedingContent];
  const workers = Array.from({ length: Math.min(CONTENT_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const op = queue.shift();
      if (!op) continue;
      if (!op.contentRef) continue;
      try {
        contentCache.set(op.pageId, await readPageContent(op.contentRef));
      } catch {
        // Recorded as a FAILURE, not as empty content.
        //
        // Collapsing the two is how a transient blob hiccup became destructive:
        // the sheet branch below treats an empty document as "this sheet was
        // empty at backup time" and clears its rows, so one unreadable blob
        // would have permanently wiped a live spreadsheet during a restore.
        readFailed.add(op.pageId);
        contentCache.set(op.pageId, '');
      }
    }
  });
  await Promise.all(workers);

  for (const op of ops) {
    if (op.op === 'soft-delete') {
      await tx
        .update(pages)
        .set({ isTrashed: true, trashedAt: new Date() })
        .where(eq(pages.id, op.pageId));
      continue;
    }

    const content = contentCache.get(op.pageId) ?? '';

    const stateHash = computePageStateHash({
      title: op.title,
      contentRef: op.contentRef,
      parentId: op.parentId,
      position: op.position ?? 0,
      isTrashed: op.isTrashed,
      type: op.type,
      driveId,
    });

    if (op.op === 'create') {
      await tx
        .insert(pages)
        .values({
          id: op.pageId,
          driveId,
          title: op.title,
          type: op.type,
          parentId: op.parentId,
          position: op.position ?? 0,
          isTrashed: op.isTrashed,
          trashedAt: op.isTrashed ? op.trashedAt : null,
          revision: 0,
          content,
          stateHash,
        });
    } else {
      await tx
        .update(pages)
        .set({
          title: op.title,
          type: op.type,
          parentId: op.parentId,
          position: op.position ?? 0,
          isTrashed: op.isTrashed,
          trashedAt: op.isTrashed ? op.trashedAt : null,
          content,
          stateHash,
          revision: sql`${pages.revision} + 1`,
        })
        .where(eq(pages.id, op.pageId));
    }

    // A sheet's content has to land in its ROWS.
    //
    // Both branches above write the document into `pages.content`, which no
    // sheet read path consults any more — so restoring a drive reported success
    // and left every spreadsheet exactly as it was. `replaceFromDocument`
    // writes the rows the restored document describes and clears the column
    // afterwards, so the two cannot disagree.
    if (isSheetType(op.type as PageType)) {
      if (content.trim()) {
        await replaceFromDocument(
          { pageId: op.pageId },
          content,
          { userId, changeGroupId },
          tx as never
        );
      } else if (!readFailed.has(op.pageId)) {
        // Genuinely empty at backup time — the blob read succeeded and returned
        // nothing, or there was no content to read. Leaving the rows would
        // report a successful restore while the spreadsheet kept its current,
        // post-backup data.
        //
        // Explicitly NOT reached when the read failed. Clearing rows on a
        // transient blob error would destroy a live spreadsheet, which is far
        // worse than a restore that leaves one page untouched.
        await tx.delete(sheetTabs).where(eq(sheetTabs.pageId, op.pageId));
      }
      if (!readFailed.has(op.pageId)) {
        await tx.update(pages).set({ content: '' }).where(eq(pages.id, op.pageId));
      }
    }

    await createPageVersion(
      {
        pageId: op.pageId,
        driveId,
        createdBy: userId,
        source: 'restore',
        content,
        pageRevision: 0,
        stateHash,
        changeGroupId,
        changeGroupType,
        metadata: { backupId },
      },
      { tx: tx as never },
    );
  }
}
