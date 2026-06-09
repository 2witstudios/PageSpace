import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { driveBackups, driveBackupPages, pageVersions } from '@pagespace/db/schema/versioning';
import { pages } from '@pagespace/db/schema/core';

export type RestoreDiff = {
  toCreate:    { pageId: string; title: string; type: string }[];
  toOverwrite: { pageId: string; title: string; type: string; currentHash: string | null; backupHash: string | null }[];
  toOrphan:    { pageId: string; title: string }[];
  unchanged:   { pageId: string }[];
};

export type BackupPageRow = {
  pageId: string;
  title: string | null;
  type: string | null;
  parentId: string | null;
  position: number | null;
  isTrashed: boolean;
  trashedAt: Date | null;
  pageVersionId: string | null;
  contentRef: string | null;
  stateHash: string | null;
};

type BackupPageInput = {
  pageId: string;
  stateHash: string | null;
  title: string;
  type: string;
  parentId: string | null;
  position: number | null;
};

type CurrentPageInput = {
  id: string;
  stateHash: string | null;
  title: string;
  type: string;
  parentId: string | null;
  position: number | null;
};

export function computeRestoreDiff(
  backupPages: BackupPageInput[],
  currentPages: CurrentPageInput[],
): RestoreDiff {
  const backupMap = new Map(backupPages.map(p => [p.pageId, p]));
  const currentMap = new Map(currentPages.map(p => [p.id, p]));

  const toCreate: RestoreDiff['toCreate'] = [];
  const toOverwrite: RestoreDiff['toOverwrite'] = [];
  const toOrphan: RestoreDiff['toOrphan'] = [];
  const unchanged: RestoreDiff['unchanged'] = [];

  for (const bpItem of backupPages) {
    const cpItem = currentMap.get(bpItem.pageId);
    if (!cpItem) {
      toCreate.push({ pageId: bpItem.pageId, title: bpItem.title, type: bpItem.type });
    } else if (
      bpItem.stateHash !== null &&
      cpItem.stateHash !== null &&
      bpItem.stateHash === cpItem.stateHash
    ) {
      unchanged.push({ pageId: bpItem.pageId });
    } else {
      toOverwrite.push({
        pageId: bpItem.pageId,
        title: bpItem.title,
        type: bpItem.type,
        backupHash: bpItem.stateHash,
        currentHash: cpItem.stateHash,
      });
    }
  }

  for (const cpItem of currentPages) {
    if (!backupMap.has(cpItem.id)) {
      toOrphan.push({ pageId: cpItem.id, title: cpItem.title });
    }
  }

  return { toCreate, toOverwrite, toOrphan, unchanged };
}

export type FetchDiffResult =
  | { ok: true; diff: RestoreDiff; backupPageMap: Map<string, BackupPageRow> }
  | { ok: false; reason: 'not_found' };

export async function fetchAndComputeRestoreDiff(
  backupId: string,
  driveId: string,
  dbInstance: typeof db,
): Promise<FetchDiffResult> {
  const backup = await dbInstance.query.driveBackups.findFirst({
    where: and(eq(driveBackups.id, backupId), eq(driveBackups.driveId, driveId)),
  });

  if (!backup) {
    return { ok: false, reason: 'not_found' };
  }

  const backupPageRows = await dbInstance
    .select({
      pageId: driveBackupPages.pageId,
      title: driveBackupPages.title,
      type: driveBackupPages.type,
      parentId: driveBackupPages.parentId,
      position: driveBackupPages.position,
      isTrashed: driveBackupPages.isTrashed,
      trashedAt: driveBackupPages.trashedAt,
      pageVersionId: driveBackupPages.pageVersionId,
      contentRef: pageVersions.contentRef,
      stateHash: pageVersions.stateHash,
    })
    .from(driveBackupPages)
    .leftJoin(pageVersions, eq(driveBackupPages.pageVersionId, pageVersions.id))
    .where(eq(driveBackupPages.backupId, backupId));

  const currentPages = await dbInstance
    .select({
      id: pages.id,
      stateHash: pages.stateHash,
      title: pages.title,
      type: pages.type,
      parentId: pages.parentId,
      position: pages.position,
    })
    .from(pages)
    .where(eq(pages.driveId, driveId));

  const backupPageMap = new Map<string, BackupPageRow>(
    backupPageRows.map(row => [row.pageId, row as BackupPageRow]),
  );

  const diff = computeRestoreDiff(
    backupPageRows.map(r => ({
      pageId: r.pageId,
      stateHash: r.stateHash ?? null,
      title: r.title ?? '',
      type: r.type ?? '',
      parentId: r.parentId ?? null,
      position: r.position ?? null,
    })),
    currentPages.map(p => ({
      id: p.id,
      stateHash: p.stateHash,
      title: p.title,
      type: p.type,
      parentId: p.parentId ?? null,
      position: p.position,
    })),
  );

  return { ok: true, diff, backupPageMap };
}
