/**
 * The re-upload gate: one call for every place bytes enter storage by hash, or
 * an existing hash is attached to something new.
 *
 * Checks the blocklist and, on a hit, records the attempt in the tamper-evident
 * audit log so case tooling can find who tried to bring blocked content back.
 * The caller only has to refuse with the neutral message.
 *
 * Applies in every deployment mode, on-prem included: it is a local database
 * lookup with no external call.
 */

import { audit, auditRequest } from '../audit/audit-log';
import type { AuditEvent } from '../audit/security-audit';
import { findBlockedHashes } from './blocklist';
import { ContentBlockedError } from './policy';

/** Where the bytes were trying to enter. Recorded on the audit event. */
export type ContentUploadEntryPoint =
  | 'upload.presign'
  | 'upload.complete'
  | 'attachment.presign'
  | 'attachment.complete'
  | 'image-generation'
  /** An agent filing a sandbox file into the drive as a FILE page (copy_content). */
  | 'sandbox-copy'
  | 'chat-attachment'
  | 'page.copy'
  | 'attachment.send';

export interface UploadGateContext {
  entryPoint: ContentUploadEntryPoint;
  /** Omitted only where the writer genuinely has no user in scope. */
  userId?: string;
  /** Present on route-driven paths; supplies IP and user agent for the audit event. */
  request?: Request;
  /** Extra IDs worth having on the audit event (drive, page, target). No user text. */
  details?: Record<string, unknown>;
}

export interface UploadGateInput extends UploadGateContext {
  contentHash: string;
}

/**
 * The subset of `contentHashes` that is blocked, from ONE blocklist query. Every
 * blocked hash has already been audited (one `content.upload.blocked` event each)
 * by the time this returns.
 */
export async function findBlockedUploads(
  contentHashes: readonly string[],
  context: UploadGateContext,
): Promise<Set<string>> {
  const blocked = await findBlockedHashes(contentHashes);

  for (const contentHash of blocked) {
    const event: AuditEvent = {
      eventType: 'content.upload.blocked',
      userId: context.userId,
      resourceType: 'file',
      resourceId: contentHash,
      // >= 0.5, so the audit pipeline also logs it at warn.
      riskScore: 0.9,
      // `entryPoint` last: a caller's details can never overwrite it.
      details: { ...context.details, entryPoint: context.entryPoint },
    };
    if (context.request) {
      auditRequest(context.request, event);
    } else {
      audit(event);
    }
  }

  return blocked;
}

/** True when the hash is blocked. The attempt has already been recorded. */
export async function isUploadBlocked({ contentHash, ...context }: UploadGateInput): Promise<boolean> {
  return (await findBlockedUploads([contentHash], context)).size > 0;
}

/** For server-side writers with no HTTP response to shape: throws on a blocked hash. */
export async function assertUploadNotBlocked(input: UploadGateInput): Promise<void> {
  if (await isUploadBlocked(input)) {
    throw new ContentBlockedError(input.contentHash);
  }
}
