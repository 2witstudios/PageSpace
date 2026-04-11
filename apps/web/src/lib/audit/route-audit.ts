import { securityAudit, loggers } from '@pagespace/lib/server';
import type { SecurityEventType } from '@pagespace/db';

const DATA_EVENT_MAP: Record<string, SecurityEventType> = {
  read: 'data.read',
  write: 'data.write',
  delete: 'data.delete',
  export: 'data.export',
  share: 'data.share',
};

interface AuditMeta {
  ipAddress: string;
  userAgent: string;
}

export function extractAuditMeta(request: Request): AuditMeta {
  const ipAddress =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown';
  const userAgent = request.headers.get('user-agent') || 'unknown';
  return { ipAddress, userAgent };
}

/**
 * Log a data-access audit event with request metadata.
 *
 * Uses logEvent() directly so ipAddress and userAgent are stored as
 * top-level AuditEvent fields — which are excluded from the hash chain
 * per GDPR compliance (#541). Putting them inside `details` would
 * include them in the hash, breaking the right-to-erasure invariant.
 */
export function logAuditEvent(
  request: Request,
  userId: string,
  operation: 'read' | 'write' | 'delete' | 'export' | 'share',
  resourceType: string,
  resourceId: string,
  details?: Record<string, unknown>
): void {
  const { ipAddress, userAgent } = extractAuditMeta(request);
  securityAudit
    .logEvent({
      eventType: DATA_EVENT_MAP[operation],
      userId,
      resourceType,
      resourceId,
      ipAddress,
      userAgent,
      details,
    })
    .catch((err: Error) => {
      loggers.api.warn('Security audit log failed', {
        error: err.message,
        resourceType,
      });
    });
}
