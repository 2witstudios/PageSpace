import { describe, it, expect } from 'vitest';
import { ORG_AUDIT_CATEGORIES, ORG_AUDIT_EVENT_TYPES } from '@pagespace/lib/audit/org-audit-query-core';
import { AUDIT_CATEGORY_LABELS, AUDIT_EVENT_SENTENCES, auditQueryString, auditSentence } from '../org-audit';

describe('audit copy', () => {
  it('AUD-1 (partial): every catalogued org event and category reads as plain words', () => {
    for (const type of ORG_AUDIT_EVENT_TYPES) {
      expect(AUDIT_EVENT_SENTENCES[type], type).toMatch(/^[a-z]/);
      expect(AUDIT_EVENT_SENTENCES[type], type).not.toMatch(/[a-z]+_[a-z]+|org\./);
    }
    for (const category of Object.keys(ORG_AUDIT_CATEGORIES)) {
      expect(AUDIT_CATEGORY_LABELS[category as keyof typeof AUDIT_CATEGORY_LABELS], category).toMatch(/^[A-Z]/);
    }
  });

  it('an event outside the catalog still reads as something, never the raw type', () => {
    expect(auditSentence('org.future.thing')).toBe('made a change');
  });

  it('names the actor, the action and the drive when there is one', () => {
    expect(auditSentence('org.drive.visibility_changed')).toBe('changed a drive’s visibility');
  });
});

describe('auditQueryString', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  it('AUD-3 (partial): filters by category, drive and time', () => {
    expect(auditQueryString({ category: 'policies', driveId: 'd1', days: 30 }, now)).toBe('category=policies&driveId=d1&from=2026-09-05T12%3A00%3A00.000Z');
  });

  it('omits filters left at All and Any', () => {
    expect(auditQueryString({ category: 'all', driveId: 'any', days: null }, now)).toBe('');
  });

  it('carries the paging cursor', () => {
    expect(auditQueryString({ category: 'all', driveId: 'any', days: 7, before: 123 }, now)).toBe('from=2026-09-28T12%3A00%3A00.000Z&before=123');
  });
});
