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
  return createValidSecurityChainWithEventTypes(
    Array.from({ length: count }, () => 'auth.login.success')
  );
}

// Builds a valid chain where each entry carries the caller-supplied event_type
// string. The eventType field is cast through AuditEvent so legacy values
// (removed from SecurityEventType) can still be used — the DB column is text
// post-migration 0105, so stored values are arbitrary strings and the verifier
// must accept them.
export function createValidSecurityChainWithEventTypes(
  eventTypes: string[]
): MockSecurityAuditEntry[] {
  const entries: MockSecurityAuditEntry[] = [];
  let previousHash = 'genesis';

  eventTypes.forEach((eventType, i) => {
    const timestamp = new Date(Date.now() + i * 1000);
    const event = {
      eventType,
      userId: 'user-123',
      sessionId: `session-${i}`,
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
    } as AuditEvent;

    const eventHash = computeSecurityEventHash(event, previousHash, timestamp);

    entries.push({
      id: `audit-${i + 1}`,
      eventType,
      userId: 'user-123',
      sessionId: `session-${i}`,
      serviceId: null,
      resourceType: null,
      resourceId: null,
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
      geoLocation: null,
      details: null,
      riskScore: null,
      anomalyFlags: null,
      timestamp,
      previousHash,
      eventHash,
    });

    previousHash = eventHash;
  });

  return entries;
}
