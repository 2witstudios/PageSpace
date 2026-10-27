/**
 * GDPR runtime enforcement (#971).
 *
 * Complements the static source-scan test (gdpr-audit-compliance.test.ts).
 * The static test only greps route source for the literal `query`. This test
 * proves the RUNTIME guard: any audit `details` emitted by a search route is
 * sanitized so user-typed search text / PII never enters the tamper-evident
 * hash chain — even if a future code path were to put it there.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeAuditDetails,
  REDACTED_MARKER,
} from '@pagespace/lib/audit/sanitize-audit-details';

describe('GDPR runtime: search route audit details are sanitized (#971)', () => {
  it('redacts query text from a /api/search-shaped details object', () => {
    // Shape mirrors apps/web/src/app/api/search/route.ts audit call, but with a
    // hypothetical regression that leaks the user query into details.
    const leaky = { query: 'my private search', resultCount: 3 };
    const safe = sanitizeAuditDetails(leaky);
    expect(safe).toEqual({ query: REDACTED_MARKER, resultCount: 3 });
  });

  it('redacts searchQuery from a /api/search/multi-drive-shaped details object', () => {
    const leaky = {
      searchQuery: 'confidential terms',
      searchType: 'text',
      resultCount: 5,
      source: 'multi-drive',
    };
    const safe = sanitizeAuditDetails(leaky);
    expect(safe?.searchQuery).toBe(REDACTED_MARKER);
    expect(safe?.searchType).toBe('text');
    expect(safe?.resultCount).toBe(5);
    expect(safe?.source).toBe('multi-drive');
  });

  it('leaves the actual (clean) search route details untouched', () => {
    // These are the real details the three search routes emit today.
    const realSearch = { resultCount: 12 };
    const realMultiDrive = { searchType: 'text', resultCount: 4, source: 'multi-drive' };
    const realMentions = { source: 'mentions', resultCount: 7 };

    expect(sanitizeAuditDetails(realSearch)).toEqual(realSearch);
    expect(sanitizeAuditDetails(realMultiDrive)).toEqual(realMultiDrive);
    expect(sanitizeAuditDetails(realMentions)).toEqual(realMentions);
  });
});
