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

import { auditDetailLine } from '../org-audit';

describe('auditDetailLine', () => {
  it('AUD-1 (partial) AUD-3 (partial): a policy change names each field and its old and new value', () => {
    expect(auditDetailLine('org.policy.changed', { changes: [
      { key: 'publicShareLinks', from: true, to: false },
      { key: 'guests', from: 'on', to: 'approve' },
      { key: 'seatAllowanceCents', from: 100, to: 150 },
      { key: 'providerAllowlist', from: null, to: ['anthropic', 'openai'] },
    ] })).toBe('Public share links: on → off · Guests: On → Admins approve · Seat allowance: 100 → 150 credits a month · AI providers: Unrestricted → 2 allowed');
  });

  it('names what a policy change suspended, restored or blocked', () => {
    expect(auditDetailLine('org.policy.suspended', { counts: { publicShareLinks: 4 }, total: 4 })).toBe('4 existing share links suspended');
    expect(auditDetailLine('org.policy.restored', { counts: { guests: 1 }, total: 1 })).toBe('1 guest restored');
    expect(auditDetailLine('org.policy.blocked', { counts: { publishedApps: 2 }, total: 2 })).toBe('2 published apps now blocked');
  });

  it('roles and visibility read from → to', () => {
    expect(auditDetailLine('org.member.role_changed', { from: 'MEMBER', to: 'ADMIN' })).toBe('Member → Admin');
    expect(auditDetailLine('org.drive.visibility_changed', { from: 'OPEN', to: 'RESTRICTED' })).toBe('Open → Restricted');
    expect(auditDetailLine('org.drive.moved_in', { orgVisibility: 'PRIVATE' })).toBe('as Private');
  });

  it('seats and billing: counts in credits, payments in dollars', () => {
    expect(auditDetailLine('org.seat.auto_add_changed', { autoAdd: true })).toBe('Automatic seats on');
    expect(auditDetailLine('org.seat.refused', { purchased: 15, held: 15 })).toBe('15 of 15 seats in use');
    expect(auditDetailLine('org.billing.pool_refilled', { allowanceCents: 9000, paidCents: 15000 })).toBe('$150 paid · 9,000 credits added to the pool');
    expect(auditDetailLine('org.domain.verified', { domain: 'northwind.com', method: 'dns' })).toBe('northwind.com · by DNS');
  });

  it('never prints identifiers or addresses, and says nothing it does not know', () => {
    expect(auditDetailLine('org.ownership.transferred', { fromUserId: 'u_1', toUserId: 'u_2' })).toBe('');
    expect(auditDetailLine('org.invite.created', { role: 'ADMIN', email: 'sam@x.io' })).toBe('as Admin');
    expect(auditDetailLine('org.future.event', { anything: 1 })).toBe('');
    expect(auditDetailLine('org.policy.changed', { changes: 'nope' })).toBe('');
  });
});
