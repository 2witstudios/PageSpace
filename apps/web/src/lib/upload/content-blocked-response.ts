import { NextResponse } from 'next/server';
import { findBlockedUploads } from '@pagespace/lib/content-safety/upload-gate';
import {
  ContentBlockedError,
  CONTENT_BLOCKED_MESSAGE,
  CONTENT_BLOCKED_STATUS,
} from '@pagespace/lib/content-safety/policy';
import {
  auditUnverifiableFileReference,
  loadFileStoragePaths,
  resolveStoredContentHash,
} from './stored-content-hash';

/**
 * The one neutral refusal for blocklisted content. The WORDING gives no reason.
 *
 * Accepted trade-off: the status and body are distinct from other upload
 * refusals, so a caller who already has an exact hash can learn whether it is
 * blocked. That is deliberate, and this response must not be merged into the
 * existing 409 "could not be verified":
 *   - a probe needs the exact sha256 — it reveals nothing about files the
 *     caller doesn't already hold or know;
 *   - every probe is audited as `content.upload.blocked` at riskScore 0.9;
 *   - a distinct response is what lets support tell a real block from an
 *     ordinary failed upload.
 */
export function contentBlockedResponse(): NextResponse {
  return NextResponse.json({ error: CONTENT_BLOCKED_MESSAGE }, { status: CONTENT_BLOCKED_STATUS });
}

/**
 * Map a ContentBlockedError thrown while persisting a chat attachment to that
 * refusal. Returns null for anything else so the caller keeps its own error
 * handling. Nothing the error carries (the hash) reaches the client.
 */
export function contentBlockedResponseFor(error: unknown): NextResponse | null {
  return error instanceof ContentBlockedError ? contentBlockedResponse() : null;
}

/**
 * The refusal for a page copy. A copy uploads nothing, so it gets its own
 * wording; like the upload refusal it gives no reason and does not say which
 * page — naming it would point at the blocked file inside a copied tree.
 */
export const CONTENT_COPY_REFUSED_MESSAGE = "One or more files can't be copied";

export function contentCopyRefusedResponse(): NextResponse {
  return NextResponse.json({ error: CONTENT_COPY_REFUSED_MESSAGE }, { status: CONTENT_BLOCKED_STATUS });
}

/**
 * Gate for a channel or DM send that attaches already-stored files by id. A
 * send uploads nothing, so the upload gates never see it: without this, a hash
 * blocked after upload — or one the sender never uploaded — could still be
 * attached to a new message.
 *
 * A file id is normally the content hash. For any id that is not, the row's
 * `storagePath` is read (one extra query, legacy rows only) and resolved the way
 * the file readers resolve it. A row whose bytes can't be tied to a hash can't
 * be checked, so the send is refused and audited. An id with no row at all is
 * left to the send's own validation, which rejects it.
 *
 * One blocklist query for the whole message. Returns the neutral refusal when
 * any attachment is blocked (each already audited), otherwise null.
 */
export async function refuseBlockedAttachments(input: {
  fileIds: readonly string[];
  request: Request;
  userId: string;
  details: Record<string, unknown>;
}): Promise<NextResponse | null> {
  if (input.fileIds.length === 0) return null;

  const hashes = new Set<string>();
  const indirect: string[] = [];
  for (const fileId of new Set(input.fileIds)) {
    const hash = resolveStoredContentHash(fileId);
    if (hash) hashes.add(hash);
    else indirect.push(fileId);
  }

  let unverifiable = false;
  if (indirect.length > 0) {
    const storagePaths = await loadFileStoragePaths(indirect);
    for (const fileId of indirect) {
      if (!storagePaths.has(fileId)) continue;
      const hash = resolveStoredContentHash(storagePaths.get(fileId) || fileId);
      if (hash) {
        hashes.add(hash);
        continue;
      }
      unverifiable = true;
      auditUnverifiableFileReference({
        request: input.request,
        userId: input.userId,
        entryPoint: 'attachment.send',
        resourceType: 'file',
        resourceId: fileId,
        details: input.details,
      });
    }
  }

  const blocked = hashes.size === 0
    ? hashes
    : await findBlockedUploads([...hashes], {
        entryPoint: 'attachment.send',
        userId: input.userId,
        request: input.request,
        details: input.details,
      });
  return blocked.size > 0 || unverifiable ? contentBlockedResponse() : null;
}
