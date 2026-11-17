import type { ContentCase } from '@pagespace/db/schema/content-safety';
import { describeCaseProgress, type CaseProgress } from '@pagespace/lib/content-safety/takedown-plan';

/**
 * What the admin console shows for a case. IDs, state and counts — the
 * evidence key, the snapshot's request IP and anything else on the row that
 * the console has no use for stay on the server.
 */
export interface CaseSummary {
  id: string;
  targetType: ContentCase['targetType'];
  targetId: string;
  contentHash: string | null;
  status: ContentCase['status'];
  category: ContentCase['category'];
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  actorUserId: string | null;
  /** The content the hash names has a verified copy in the evidence bucket. */
  evidencePreserved: boolean;
  /** Further objects found under the hash's keys that were NOT that content, each kept byte for byte. */
  otherObjectsPreserved: number;
  progress: CaseProgress;
  references: {
    pageIds: string[];
    driveIds: string[];
    fileIds: string[];
    uploaderUserIds: string[];
    messageCount: number;
    truncated: boolean;
  } | null;
  skippedDrives: Array<{ driveId: string; reason: string }>;
}

function skippedDrivesOf(snapshot: ContentCase['snapshot']): CaseSummary['skippedDrives'] {
  const value = snapshot?.skippedDrives;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { driveId, reason } = entry as { driveId?: unknown; reason?: unknown };
    return typeof driveId === 'string' && typeof reason === 'string' ? [{ driveId, reason }] : [];
  });
}

export function toCaseSummary(row: ContentCase): CaseSummary {
  const snapshot = row.snapshot;
  const refs = snapshot?.references;
  return {
    id: row.id,
    targetType: row.targetType,
    // A published URL names the site; show it as typed. Everything else is an ID or a hash.
    targetId: row.targetId,
    contentHash: row.contentHash,
    status: row.status,
    category: row.category,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    actorUserId: snapshot?.takedown?.actorUserId ?? null,
    evidencePreserved: typeof snapshot?.evidenceKey === 'string',
    otherObjectsPreserved: snapshot?.additionalEvidenceKeys?.length ?? 0,
    progress: describeCaseProgress(row),
    references: refs
      ? {
          pageIds: refs.pageIds,
          driveIds: refs.driveIds,
          fileIds: refs.fileIds,
          uploaderUserIds: refs.uploaderUserIds,
          messageCount: refs.channelMessageIds.length + refs.directMessageIds.length + refs.aiMessageIds.length,
          truncated: refs.truncated,
        }
      : snapshot?.driveIds || snapshot?.pageIds
        ? {
            pageIds: snapshot.pageIds ?? [],
            driveIds: snapshot.driveIds ?? [],
            fileIds: [],
            uploaderUserIds: snapshot.uploaderUserId ? [snapshot.uploaderUserId] : [],
            messageCount: 0,
            truncated: false,
          }
        : null,
    skippedDrives: skippedDrivesOf(snapshot),
  };
}
