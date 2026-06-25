/**
 * RED-first unit tests for the pure audit-details sanitizer (#971).
 *
 * GDPR Art 5(1)(c) data minimization. The `details` field of a security-audit
 * event is folded into the tamper-evident hash chain and CANNOT be erased under
 * Art 17. This guard ensures user-typed search text and PII never reach that
 * hash chain at runtime — not relying on a static source-scan alone.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeAuditDetails,
  REDACTED_MARKER,
  DENYLISTED_DETAIL_KEYS,
} from '../sanitize-audit-details';

describe('sanitizeAuditDetails (#971)', () => {
  it('redacts a user-typed `query` key', () => {
    const input = { query: 'my secret search', resultCount: 3 };
    const out = sanitizeAuditDetails(input);
    expect(out).toEqual({ query: REDACTED_MARKER, resultCount: 3 });
  });

  it('redacts every denylisted user-typed / PII key', () => {
    const input: Record<string, unknown> = {
      query: 'q text',
      q: 'q text',
      searchQuery: 'q text',
      searchTerm: 'term',
      text: 'free text',
      prompt: 'a prompt',
      content: 'body content',
      email: 'user@example.com',
      resultCount: 7,
    };
    const out = sanitizeAuditDetails(input)!;
    for (const key of DENYLISTED_DETAIL_KEYS) {
      if (key in input) {
        expect(out[key]).toBe(REDACTED_MARKER);
      }
    }
    // safe metadata survives
    expect(out.resultCount).toBe(7);
  });

  it('is case-insensitive on key names', () => {
    const input = { Query: 'x', SearchQuery: 'y', Email: 'z', count: 1 };
    const out = sanitizeAuditDetails(input)!;
    expect(out.Query).toBe(REDACTED_MARKER);
    expect(out.SearchQuery).toBe(REDACTED_MARKER);
    expect(out.Email).toBe(REDACTED_MARKER);
    expect(out.count).toBe(1);
  });

  it('returns a clean details object deep-equal and value-unchanged', () => {
    const input = {
      resultCount: 5,
      source: 'multi-drive',
      durationMs: 42,
      driveId: 'drv_123',
      searchType: 'text',
    };
    const out = sanitizeAuditDetails(input);
    expect(out).toEqual(input);
  });

  it('does NOT mutate its input (returns a new object)', () => {
    const input = { query: 'leak me', resultCount: 1 };
    const snapshot = { ...input };
    const out = sanitizeAuditDetails(input);
    expect(out).not.toBe(input);
    expect(input).toEqual(snapshot); // original untouched
  });

  it('is referentially transparent: same input twice => deep-equal output', () => {
    const input = { query: 'abc', searchType: 'regex', resultCount: 9 };
    const a = sanitizeAuditDetails(input);
    const b = sanitizeAuditDetails(input);
    expect(a).toEqual(b);
  });

  it('does not throw on undefined', () => {
    expect(() => sanitizeAuditDetails(undefined)).not.toThrow();
    expect(sanitizeAuditDetails(undefined)).toBeUndefined();
  });

  it('does not throw on null and returns undefined', () => {
    expect(() => sanitizeAuditDetails(null as unknown as undefined)).not.toThrow();
    expect(sanitizeAuditDetails(null as unknown as undefined)).toBeUndefined();
  });

  it('redacts denylisted keys even when value is not a string (e.g. number/object)', () => {
    const input = { query: 12345, content: { nested: 'pii' }, ok: true };
    const out = sanitizeAuditDetails(input)!;
    expect(out.query).toBe(REDACTED_MARKER);
    expect(out.content).toBe(REDACTED_MARKER);
    expect(out.ok).toBe(true);
  });
});
