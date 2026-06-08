import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { readPageContent } from '@pagespace/lib/services/page-content-store';
import { createPageVersion, computePageStateHash } from '@pagespace/lib/services/page-version-service';
import type { RestoreDiff, BackupPageRow } from './restore-diff-service';

export type PageRestoreOp =
  | { op: 'create'; pageId: string; title: string; type: string; parentId: string | null; position: number | null; contentRef: string | null }
  | { op: 'overwrite'; pageId: string; title: string; type: string; parentId: string | null; position: number | null; contentRef: string | null }
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
};

export async function applyPageRestoreOps(
  ops: PageRestoreOp[],
  driveId: string,
  userId: string,
  backupId: string,
  changeGroupId: string,
  tx: DbLike,
): Promise<void> {
  for (const op of ops) {
    if (op.op === 'soft-delete') {
      await tx
        .update(pages)
        .set({ isTrashed: true, trashedAt: new Date() })
        .where(eq(pages.id, op.pageId));
      continue;
    }

    const content = op.contentRef ? await readPageContent(op.contentRef) : '';

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
          isTrashed: false,
          revision: 0,
          content,
        });
    } else {
      await tx
        .update(pages)
        .set({
          title: op.title,
          type: op.type,
          parentId: op.parentId,
          position: op.position ?? 0,
          isTrashed: false,
          content,
        })
        .where(eq(pages.id, op.pageId));
    }

    const stateHash = computePageStateHash({
      title: op.title,
      contentRef: op.contentRef,
      parentId: op.parentId,
      position: op.position ?? 0,
      isTrashed: false,
      type: op.type,
      driveId,
    });

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
        metadata: { backupId },
      },
      { tx: tx as never },
    );
  }
}
