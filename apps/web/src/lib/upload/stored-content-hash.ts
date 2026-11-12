import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { files } from '@pagespace/db/schema/storage';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { normalizeContentHash } from '@pagespace/lib/content-safety/policy';
import type { ContentUploadEntryPoint } from '@pagespace/lib/content-safety/upload-gate';
import { toContentHash } from '@/lib/presigned-url';

/**
 * The content hash a stored reference points at, or null when it can't be
 * determined. Accepts what the file readers accept: a bare sha256, or the legacy
 * `files/<hash>/original` key form (via the readers' own `toContentHash`).
 *
 * Null means the bytes can't be checked against the blocklist at all — callers
 * that would attach those bytes to something new must refuse.
 */
export function resolveStoredContentHash(value: string): string | null {
  return normalizeContentHash(toContentHash(value));
}

/**
 * `storagePath` for each `files` row among `fileIds`. An id with no row is absent
 * from the map. Only needed for ids that are not themselves a content hash.
 */
export async function loadFileStoragePaths(fileIds: readonly string[]): Promise<Map<string, string | null>> {
  if (fileIds.length === 0) return new Map();
  const rows = await db
    .select({ id: files.id, storagePath: files.storagePath })
    .from(files)
    .where(inArray(files.id, [...fileIds]));
  return new Map(rows.map((row) => [row.id, row.storagePath]));
}

/**
 * Record a refusal made because a stored file reference could not be resolved to
 * a content hash. Same event type as a blocklist hit so case tooling sees every
 * refusal in one place; `reason` and the non-hash `resourceId` tell them apart.
 */
export function auditUnverifiableFileReference(input: {
  request: Request;
  userId: string;
  entryPoint: ContentUploadEntryPoint;
  resourceType: 'page' | 'file';
  resourceId: string;
  details: Record<string, unknown>;
}): void {
  auditRequest(input.request, {
    eventType: 'content.upload.blocked',
    userId: input.userId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    riskScore: 0.5,
    details: { ...input.details, entryPoint: input.entryPoint, reason: 'unverifiable_file_reference' },
  });
}
