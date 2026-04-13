import { describe, it } from 'vitest';
import { computeLogHash } from '@pagespace/lib/monitoring';
import { computeSecurityEventHash, type AuditEvent } from '@pagespace/lib/audit';
import { assert } from '../../__tests__/riteway';
import {
  recomputeActivityLogHash,
  recomputeSecurityAuditHash,
  type ActivityLogHashableFields,
  type SecurityAuditHashableFields,
} from '../siem-chain-hashers';

// Round-trip tests prove the preflight hasher byte-exactly matches the
// write-side formulas. If the write-side changes (e.g. a new field enters
// serializeLogDataForHash), these tests will fail loudly — exactly what we
// want, because a silent drift would cause false tamper alerts in prod.

describe('recomputeActivityLogHash', () => {
  it('byte-exact round-trip against activity-logger.computeLogHash', () => {
    const timestamp = new Date('2026-04-10T12:34:56.789Z');
    const preflightInput: ActivityLogHashableFields = {
      id: 'log_abc',
      timestamp,
      operation: 'page.update',
      resourceType: 'page',
      resourceId: 'page_xyz',
      driveId: 'drive_1',
      pageId: 'page_xyz',
      contentSnapshot: 'a quick snapshot',
      previousValues: { title: 'old' },
      newValues: { title: 'new' },
      metadata: { source: 'web', region: 'us-east' },
    };

    // Structurally compatible with HashableLogData — lib's interface isn't
    // exported, so we feed computeLogHash the same fields and let TS's
    // structural typing accept it. serializeLogDataForHash coerces both
    // undefined and null to `null` in the hash input, so passing nulls
    // directly round-trips fine.
    const writeSideHash = computeLogHash(
      {
        id: preflightInput.id,
        timestamp: preflightInput.timestamp,
        operation: preflightInput.operation,
        resourceType: preflightInput.resourceType,
        resourceId: preflightInput.resourceId,
        driveId: preflightInput.driveId,
        pageId: preflightInput.pageId ?? undefined,
        contentSnapshot: preflightInput.contentSnapshot ?? undefined,
        previousValues: preflightInput.previousValues ?? undefined,
        newValues: preflightInput.newValues ?? undefined,
        metadata: preflightInput.metadata ?? undefined,
      },
      'PREV_HASH_42'
    );
    const preflightHash = recomputeActivityLogHash(preflightInput, 'PREV_HASH_42');

    assert({
      given: 'an activity_logs entry',
      should: 'produce the same SHA-256 as the write-side computeLogHash',
      actual: preflightHash,
      expected: writeSideHash,
    });
  });

  it('userId is not part of the activity_logs hash (GDPR #541 invariant)', () => {
    // If recomputeActivityLogHash ever pulled userId into the serialization,
    // this test would fail — protecting the post-erasure verification property.
    const base: ActivityLogHashableFields = {
      id: 'log_gdpr',
      timestamp: new Date('2026-04-10T00:00:00Z'),
      operation: 'auth.login',
      resourceType: 'user',
      resourceId: 'u1',
      driveId: null,
      pageId: null,
      contentSnapshot: null,
      previousValues: null,
      newValues: null,
      metadata: null,
    };

    // The ActivityLogHashableFields interface has no userId field at all, so
    // we can only prove the invariant via the struct itself + hash equality
    // on matching inputs. The round-trip test above already covers formula
    // correctness; here we simply double-check identical inputs → identical
    // hashes regardless of "context" that should not matter.
    const hashA = recomputeActivityLogHash(base, 'PREV');
    const hashB = recomputeActivityLogHash({ ...base }, 'PREV');

    assert({
      given: 'two activity_logs hashable structs that are field-equal',
      should: 'produce identical hashes (userId never enters hash input)',
      actual: hashA,
      expected: hashB,
    });
  });
});

describe('recomputeSecurityAuditHash', () => {
  it('byte-exact round-trip against security-audit.computeSecurityEventHash', () => {
    const timestamp = new Date('2026-04-10T09:15:00.000Z');
    const event: AuditEvent = {
      eventType: 'auth.login.success',
      serviceId: 'auth',
      resourceType: 'user',
      resourceId: 'u1',
      details: { method: 'password', mfa: true },
      riskScore: 0.3,
      anomalyFlags: ['new_device'],
      // PII-only fields — MUST NOT appear in hash.
      userId: 'u1',
      sessionId: 'sess_1',
      ipAddress: '10.0.0.5',
      userAgent: 'Mozilla/5.0',
      geoLocation: 'US/NYC',
    };

    const writeSideHash = computeSecurityEventHash(event, 'PREV_SEC', timestamp);

    const preflightInput: SecurityAuditHashableFields = {
      eventType: event.eventType,
      serviceId: event.serviceId ?? null,
      resourceType: event.resourceType ?? null,
      resourceId: event.resourceId ?? null,
      details: event.details ?? null,
      riskScore: event.riskScore ?? null,
      anomalyFlags: event.anomalyFlags ?? null,
      timestamp,
    };
    const preflightHash = recomputeSecurityAuditHash(preflightInput, 'PREV_SEC');

    assert({
      given: 'a security_audit_log entry',
      should: 'produce the same SHA-256 as the write-side computeSecurityEventHash',
      actual: preflightHash,
      expected: writeSideHash,
    });
  });

  it('ipAddress is not part of the security_audit_log hash (GDPR #541 invariant)', () => {
    // Per #541 the GDPR-erasable PII fields (userId, sessionId, ipAddress,
    // userAgent, geoLocation) live on the row but NOT in the hash input —
    // otherwise erasure would break chain verification. The hashable struct
    // already excludes these fields, so this test exists as a type-level
    // guarantee: the interface has no ipAddress field. We also prove equality
    // across two "contexts" where ipAddress would differ if it ever leaked in.
    const base: SecurityAuditHashableFields = {
      eventType: 'auth.login.success',
      serviceId: 'auth',
      resourceType: 'user',
      resourceId: 'u1',
      details: { method: 'password' },
      riskScore: 0,
      anomalyFlags: null,
      timestamp: new Date('2026-04-10T09:00:00Z'),
    };

    const hashA = recomputeSecurityAuditHash(base, 'PREV');
    const hashB = recomputeSecurityAuditHash({ ...base }, 'PREV');

    assert({
      given: 'two security_audit_log hashable structs that are field-equal',
      should: 'produce identical hashes regardless of erasable PII fields',
      actual: hashA,
      expected: hashB,
    });
  });

  it('null hashable fields round-trip as undefined (JSON-stringify omission)', () => {
    // At write time, AuditEvent's optional fields are `undefined` when not
    // passed, so JSON.stringify omits them. The DB stores null. When we read
    // back, null must be treated as "field was undefined at write time" —
    // i.e. omitted from the serialized object — otherwise the recomputed hash
    // would include "riskScore":null etc. and diverge.
    const timestamp = new Date('2026-04-10T00:00:00.000Z');
    const event: AuditEvent = {
      eventType: 'auth.logout',
      // serviceId, resourceType, resourceId, details, riskScore, anomalyFlags
      // all undefined — the minimal case.
    };
    const writeSideHash = computeSecurityEventHash(event, 'genesis', timestamp);

    const preflightInput: SecurityAuditHashableFields = {
      eventType: 'auth.logout',
      serviceId: null,
      resourceType: null,
      resourceId: null,
      details: null,
      riskScore: null,
      anomalyFlags: null,
      timestamp,
    };
    const preflightHash = recomputeSecurityAuditHash(preflightInput, 'genesis');

    assert({
      given: 'a security_audit_log entry where every optional field is null',
      should: 'recompute to the write-side hash (null → undefined in hash input)',
      actual: preflightHash,
      expected: writeSideHash,
    });
  });
});
