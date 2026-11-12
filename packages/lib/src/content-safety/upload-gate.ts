/**
 * The re-upload gate: one call for every place bytes enter storage by hash.
 *
 * Checks the blocklist and, on a hit, records the attempt (tamper-evident audit
 * log + structured security log) so case tooling can find who tried to bring
 * blocked content back. The caller only has to refuse with the neutral message.
 *
 * Applies in every deployment mode, on-prem included: it is a local database
 * lookup with no external call.
 */

import { audit, auditRequest } from '../audit/audit-log';
import type { AuditEvent } from '../audit/security-audit';
import { loggers } from '../logging/logger-config';
import { isHashBlocked } from './blocklist';
import { ContentBlockedError } from './policy';

/** Where the bytes were trying to enter. Recorded on the audit event. */
export type ContentUploadEntryPoint =
  | 'upload.presign'
  | 'upload.complete'
  | 'attachment.presign'
  | 'attachment.complete'
  | 'image-generation'
  | 'chat-attachment';

export interface UploadGateInput {
  contentHash: string;
  entryPoint: ContentUploadEntryPoint;
  /** Omitted only where the writer genuinely has no user in scope. */
  userId?: string;
  /** Present on route-driven paths; supplies IP and user agent for the audit event. */
  request?: Request;
  /** Extra IDs worth having on the audit event (drive, page, target). No user text. */
  details?: Record<string, unknown>;
}

/** True when the hash is blocked. The attempt has already been recorded. */
export async function isUploadBlocked(input: UploadGateInput): Promise<boolean> {
  const { contentHash, entryPoint, userId, request, details } = input;

  if (!(await isHashBlocked(contentHash))) return false;

  const event: AuditEvent = {
    eventType: 'authz.access.denied',
    userId,
    resourceType: 'file',
    resourceId: contentHash,
    riskScore: 0.9,
    details: { reason: 'content_blocked', entryPoint, ...details },
  };
  if (request) {
    auditRequest(request, event);
  } else {
    audit(event);
  }
  loggers.security.warn('Blocked content upload refused', { contentHash, userId, entryPoint, ...details });

  return true;
}

/** For server-side writers with no HTTP response to shape: throws on a blocked hash. */
export async function assertUploadNotBlocked(input: UploadGateInput): Promise<void> {
  if (await isUploadBlocked(input)) {
    throw new ContentBlockedError(input.contentHash);
  }
}
