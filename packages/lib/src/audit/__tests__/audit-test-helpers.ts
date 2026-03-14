import { computeSecurityEventHash, type AuditEvent } from '../security-audit';

export interface MockSecurityAuditEntry {
  id: string;
  eventType: string;
  userId: string | null;
  sessionId: string | null;
  serviceId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  geoLocation: string | null;
  details: Record<string, unknown> | null;
  riskScore: number | null;
  anomalyFlags: string[] | null;
  timestamp: Date;
  previousHash: string;
  eventHash: string;
}

export function createValidSecurityChain(count: number): MockSecurityAuditEntry[] {
  const entries: MockSecurityAuditEntry[] = [];
  let previousHash = 'genesis';

  for (let i = 0; i < count; i++) {
    const timestamp = new Date(Date.now() + i * 1000);
    const event: AuditEvent = {
      eventType: 'auth.login.success',
      userId: 'user-123',
      sessionId: `session-${i}`,
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
    };

    const eventHash = computeSecurityEventHash(event, previousHash, timestamp);

    entries.push({
      id: `audit-${i + 1}`,
      eventType: event.eventType,
      userId: event.userId ?? null,
      sessionId: event.sessionId ?? null,
      serviceId: null,
      resourceType: null,
      resourceId: null,
      ipAddress: event.ipAddress ?? null,
      userAgent: event.userAgent ?? null,
      geoLocation: null,
      details: null,
      riskScore: null,
      anomalyFlags: null,
      timestamp,
      previousHash,
      eventHash,
    });

    previousHash = eventHash;
  }

  return entries;
}
