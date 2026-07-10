/**
 * Emission hash — pure content fingerprint for the lock-free audit write
 * path (#890 Phase 2, leaf 1).
 *
 * Computed in-process at emission time over the SAME PII-excluded field set
 * as computeSecurityEventHash (security-audit.ts) but WITHOUT previousHash:
 * chain linkage (chainHash = H(emissionHash, prevHash)) belongs to the
 * single-writer chainer (leaf 2), so the emitter needs no lock, no head
 * read, and no transaction — one INSERT into the Admin PG ingest table.
 *
 * Excluded: userId, sessionId, ipAddress, userAgent, geoLocation (GDPR
 * right-to-erasure targets, #541) and previousHash (chain-step input).
 * Included: eventType, serviceId, resourceType, resourceId, details,
 *           riskScore, anomalyFlags, timestamp.
 *
 * Semantics are pinned by golden vectors in __tests__/emission-hash.test.ts.
 */

import { createHash } from 'crypto';
import { stableStringify } from '../utils/stable-stringify';
import type { AuditEvent } from './security-audit';

/**
 * Compute the SHA-256 emission hash for a security event.
 *
 * @param event - The event data (PII fields are ignored)
 * @param timestamp - Event timestamp (part of the hashed content)
 * @returns Hexadecimal SHA-256 hash string
 */
export function computeEmissionHash(event: AuditEvent, timestamp: Date): string {
  const payload = {
    anomalyFlags: event.anomalyFlags ?? null,
    details: event.details ?? null,
    eventType: event.eventType,
    resourceId: event.resourceId ?? null,
    resourceType: event.resourceType ?? null,
    riskScore: event.riskScore ?? null,
    serviceId: event.serviceId ?? null,
    timestamp: timestamp.toISOString(),
  };

  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}
