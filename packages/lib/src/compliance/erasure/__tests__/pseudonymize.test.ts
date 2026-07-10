import { describe, it, expect } from 'vitest';
import {
  ACTIVITY_LOG_HASHED_FIELDS,
  SECURITY_AUDIT_HASHED_FIELDS,
  buildActivityLogPseudonymizationPatch,
  buildSecurityAuditPseudonymizationPatch,
  assertPseudonymizationPatchSafe,
} from '../pseudonymize';

describe('activity-log pseudonymization patch', () => {
  it('should overwrite only the denormalized PII columns (actor + resourceTitle)', () => {
    const patch = buildActivityLogPseudonymizationPatch();
    expect(patch).toEqual({
      actorEmail: 'erased@pseudonymized',
      actorDisplayName: null,
      resourceTitle: null,
    });
  });

  it('should NOT touch any hash-chained or content field', () => {
    const patch = buildActivityLogPseudonymizationPatch();
    expect(() =>
      assertPseudonymizationPatchSafe(patch, ACTIVITY_LOG_HASHED_FIELDS)
    ).not.toThrow();
  });
});

describe('security-audit pseudonymization patch', () => {
  it('should null only the non-hashed denormalized PII columns, including the ip blind index', () => {
    const patch = buildSecurityAuditPseudonymizationPatch();
    expect(patch).toEqual({
      ipAddress: null,
      // The blind index is DERIVED from the IP — leaving it while nulling
      // ip_address keeps the subject's IP linkable by equality (#890 leaf 6).
      ipBidx: null,
      userAgent: null,
      geoLocation: null,
      sessionId: null,
    });
  });

  it('should NOT touch any hash-chained field', () => {
    const patch = buildSecurityAuditPseudonymizationPatch();
    expect(() =>
      assertPseudonymizationPatchSafe(patch, SECURITY_AUDIT_HASHED_FIELDS)
    ).not.toThrow();
  });
});

describe('assertPseudonymizationPatchSafe', () => {
  it('given a patch that touches a hashed field, should throw loudly', () => {
    expect(() =>
      assertPseudonymizationPatchSafe(
        { eventHash: 'tampered' },
        SECURITY_AUDIT_HASHED_FIELDS
      )
    ).toThrow(/hash-chain/i);
  });

  it('the canonical hashed-field sets include the integrity columns', () => {
    expect(ACTIVITY_LOG_HASHED_FIELDS.has('logHash')).toBe(true);
    expect(ACTIVITY_LOG_HASHED_FIELDS.has('previousLogHash')).toBe(true);
    expect(ACTIVITY_LOG_HASHED_FIELDS.has('contentSnapshot')).toBe(true);
    expect(SECURITY_AUDIT_HASHED_FIELDS.has('eventHash')).toBe(true);
    expect(SECURITY_AUDIT_HASHED_FIELDS.has('previousHash')).toBe(true);
    expect(SECURITY_AUDIT_HASHED_FIELDS.has('details')).toBe(true);
  });
});
