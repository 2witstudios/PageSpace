import { securityAudit, loggers } from '@pagespace/lib/server';

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
    .logDataAccess(userId, operation, resourceType, resourceId, {
      ...details,
      ipAddress,
      userAgent,
    })
    .catch((err: Error) => {
      loggers.api.warn('Security audit log failed', {
        error: err.message,
        resourceType,
      });
    });
}
