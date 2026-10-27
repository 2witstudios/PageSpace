/**
 * Runtime PII enforcement for search audit details (GDPR #971).
 *
 * Audit `details` are folded into the tamper-evident hash chain and cannot be
 * erased under Art 17, so user-typed query text must never enter them. The old
 * test only static-checked the route source for the literal `query`. This pure
 * whitelist builder makes the guarantee structural and runtime-testable: it
 * cannot emit a query field even when handed one.
 */
import { describe, it, expect } from 'vitest';
import { buildSearchAuditDetails, auditDetailsContainText } from './search-audit-details';

describe('buildSearchAuditDetails', () => {
  it('given result metadata, should produce only whitelisted fields', () => {
    const details = buildSearchAuditDetails({ resultCount: 3, source: 'multi-drive', searchType: 'all' });
    expect(details).toEqual({ resultCount: 3, source: 'multi-drive', searchType: 'all' });
  });

  it('given a query smuggled via an untyped extra field, should NOT include it', () => {
    const dirty = { resultCount: 1, query: 'alice secret medical record' } as unknown as {
      resultCount: number;
    };
    const details = buildSearchAuditDetails(dirty);
    expect(JSON.stringify(details)).not.toContain('alice secret medical record');
    expect('query' in details).toBe(false);
  });

  it('given only a result count, should omit optional fields entirely', () => {
    expect(buildSearchAuditDetails({ resultCount: 0 })).toEqual({ resultCount: 0 });
  });
});

describe('auditDetailsContainText (runtime guard)', () => {
  it('given a query that does not appear, should be false', () => {
    const details = buildSearchAuditDetails({ resultCount: 2 });
    expect(auditDetailsContainText(details, 'sensitive query')).toBe(false);
  });

  it('given details that accidentally embed the query, should detect it', () => {
    expect(auditDetailsContainText({ note: 'q=sensitive' }, 'sensitive')).toBe(true);
  });

  it('given an empty query, should be false (nothing to leak)', () => {
    expect(auditDetailsContainText({ resultCount: 1 }, '')).toBe(false);
  });
});
