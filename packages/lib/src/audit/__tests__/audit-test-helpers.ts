import { computeSecurityEventHash, type AuditEvent } from '../security-audit';
import { computeEmissionHash } from '../emission-hash';
import { computeChainHash } from '../chain-step';

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
  /**
   * Chainer-era rows (#890 Phase 2) carry the emission hash; legacy rows
   * read as null/undefined (the main-plane table has no such column).
   */
  emissionHash?: string | null;
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

/**
 * Builds a valid CHAINER-ERA chain segment (#890 Phase 2): each row carries
 * emission_hash = computeEmissionHash(event, timestamp) and
 * event_hash = computeChainHash(emission_hash, previous_hash) — the
 * single-writer chainer's semantics, verified era-aware by the periodic
 * verifier since leaf 5.
 *
 * `previousHash` lets a chainer segment continue a legacy chain (the era
 * boundary the backfill leaf plants): pass the legacy head's event_hash.
 */
export function createValidChainerEraChain(
  count: number,
  opts: { previousHash?: string; startIndex?: number } = {}
): MockSecurityAuditEntry[] {
  const entries: MockSecurityAuditEntry[] = [];
  let previousHash = opts.previousHash ?? 'genesis';
  const startIndex = opts.startIndex ?? 0;

  for (let i = 0; i < count; i++) {
    const timestamp = new Date(Date.now() + (startIndex + i) * 1000);
    const event: AuditEvent = {
      eventType: 'auth.login.success',
      userId: 'user-123',
      sessionId: `session-${startIndex + i}`,
      resourceType: 'page',
      resourceId: `page-${startIndex + i}`,
      details: { seq: startIndex + i },
    };

    const emissionHash = computeEmissionHash(event, timestamp);
    const eventHash = computeChainHash(emissionHash, previousHash);

    entries.push({
      id: `chained-${startIndex + i + 1}`,
      eventType: event.eventType,
      userId: 'user-123',
      sessionId: `session-${startIndex + i}`,
      serviceId: null,
      resourceType: 'page',
      resourceId: `page-${startIndex + i}`,
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
      geoLocation: null,
      details: { seq: startIndex + i },
      riskScore: null,
      anomalyFlags: null,
      timestamp,
      previousHash,
      eventHash,
      emissionHash,
    });

    previousHash = eventHash;
  }

  return entries;
}
