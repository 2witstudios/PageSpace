import { NextResponse } from 'next/server';
import { findBlockedUploads } from '@pagespace/lib/content-safety/upload-gate';
import {
  ContentBlockedError,
  CONTENT_BLOCKED_MESSAGE,
  CONTENT_BLOCKED_STATUS,
} from '@pagespace/lib/content-safety/policy';

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
 * Gate for a channel or DM send that attaches already-stored files by id (the
 * file id IS the content hash). A send uploads nothing, so the upload gates
 * never see it: without this, a hash blocked after upload — or one the sender
 * never uploaded — could still be attached to a new message.
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
  const blocked = await findBlockedUploads(input.fileIds, {
    entryPoint: 'attachment.send',
    userId: input.userId,
    request: input.request,
    details: input.details,
  });
  return blocked.size > 0 ? contentBlockedResponse() : null;
}
