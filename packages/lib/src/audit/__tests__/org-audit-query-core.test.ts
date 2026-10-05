import { describe, it, expect } from 'vitest';
import {
  ORG_AUDIT_CATEGORIES,
  ORG_AUDIT_EVENT_TYPES,
  ORG_AUDIT_CSV_COLUMNS,
  categoryOfOrgEvent,
  csvField,
  orgAuditCsvRow,
  parseOrgAuditFilter,
} from '../org-audit-query-core';

describe('the org audit catalog', () => {
  it('AUD-1 (partial) names a category for every kind of org-scoped event the Spec lists', () => {
    expect(Object.keys(ORG_AUDIT_CATEGORIES).sort()).toEqual([
      'automations', 'billing', 'compute', 'domains', 'donations', 'drive_moves', 'invites', 'membership', 'policies', 'private_drive_access', 'seats', 'visibility', 'wallets',
    ].sort());
    for (const types of Object.values(ORG_AUDIT_CATEGORIES)) expect(types.length).toBeGreaterThan(0);
  });

  it('AUD-1 (partial) every event type belongs to exactly one category', () => {
    const all = Object.values(ORG_AUDIT_CATEGORIES).flat();
    expect(new Set(all).size).toBe(all.length);
    expect([...ORG_AUDIT_EVENT_TYPES].sort()).toEqual([...all].sort());
    for (const type of all) expect(categoryOfOrgEvent(type)).not.toBeNull();
  });

  it('AUD-1 (partial) org power used on a drive (the row an Owner or Admin opening a Private drive writes) is filed as private-drive access; anything else outside the catalog is not an org event', () => {
    expect(categoryOfOrgEvent('authz.access.granted')).toBe('private_drive_access');
    expect(categoryOfOrgEvent('data.read')).toBeNull();
    expect(categoryOfOrgEvent('auth.login.success')).toBeNull();
  });
});

describe('parseOrgAuditFilter', () => {
  it('AUD-3 (partial) accepts type, category, drive and a time window', () => {
    const parsed = parseOrgAuditFilter({ type: 'org.policy.changed', driveId: 'd1', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z', limit: '50' });
    expect(parsed).toEqual({
      ok: true,
      filter: { eventTypes: ['org.policy.changed'], driveId: 'd1', from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-02T00:00:00Z'), limit: 50, before: null },
    });
  });

  it('AUD-3 (partial) a category expands to its event types; no filter means every org event type', () => {
    const byCategory = parseOrgAuditFilter({ category: 'visibility' });
    expect(byCategory.ok && byCategory.filter.eventTypes).toEqual([...ORG_AUDIT_CATEGORIES.visibility]);
    const all = parseOrgAuditFilter({});
    expect(all.ok && all.filter.eventTypes).toEqual([...ORG_AUDIT_EVENT_TYPES]);
    expect(all.ok && all.filter.limit).toBe(100);
  });

  it('AUD-3 (partial) refuses a type outside the org catalog, so the query can never be widened to the rest of the security log', () => {
    expect(parseOrgAuditFilter({ type: 'auth.login.success' })).toEqual({ ok: false, error: 'Unknown event type' });
    expect(parseOrgAuditFilter({ type: 'data.read' })).toEqual({ ok: false, error: 'Unknown event type' });
    expect(parseOrgAuditFilter({ category: 'everything' })).toEqual({ ok: false, error: 'Unknown category' });
  });

  it('AUD-3 (partial) a type and a category that disagree match nothing rather than the union', () => {
    expect(parseOrgAuditFilter({ type: 'org.policy.changed', category: 'billing' })).toEqual({ ok: false, error: 'The event type is not in that category' });
  });

  it('AUD-3 (partial) refuses unreadable times, an inverted window, a bad cursor and an out-of-range page size', () => {
    expect(parseOrgAuditFilter({ from: 'yesterday' })).toEqual({ ok: false, error: 'Invalid from' });
    expect(parseOrgAuditFilter({ to: 'soon' })).toEqual({ ok: false, error: 'Invalid to' });
    expect(parseOrgAuditFilter({ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' })).toEqual({ ok: false, error: 'from is after to' });
    expect(parseOrgAuditFilter({ before: '12x' })).toEqual({ ok: false, error: 'Invalid cursor' });
    expect(parseOrgAuditFilter({ limit: '0' })).toEqual({ ok: false, error: 'limit must be 1-500' });
    expect(parseOrgAuditFilter({ limit: '501' })).toEqual({ ok: false, error: 'limit must be 1-500' });
    const cursor = parseOrgAuditFilter({ before: '9007' });
    expect(cursor.ok && cursor.filter.before).toBe(9007);
  });
});

describe('CSV', () => {
  it('AUD-3 (partial) quotes a field holding a comma, a quote or a line break, doubling inner quotes', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    expect(csvField(null)).toBe('');
  });

  it.each(['=HYPERLINK("http://evil")', '+1+1', '-2+3', '@SUM(A1)', '\tTAB', '\rCR'])(
    'AUD-3 (partial) neutralizes %j so a spreadsheet can never run it as a formula',
    (value) => {
      const out = csvField(value);
      const unquoted = out.startsWith('"') ? out.slice(1) : out;
      expect(unquoted.startsWith("'")).toBe(true);
    },
  );

  it('AUD-3 (partial) a row has one field per column, actor names only where the caller can see the actor, and never an IP or user agent', () => {
    expect(ORG_AUDIT_CSV_COLUMNS).toEqual(['timestamp', 'category', 'event_type', 'actor_id', 'actor_name', 'resource_type', 'resource_id', 'drive_id', 'details']);
    const row = orgAuditCsvRow({
      timestamp: new Date('2026-10-01T12:00:00Z'),
      eventType: 'org.policy.changed',
      category: 'policies',
      actorId: 'u1',
      actorName: '=evil',
      resourceType: 'organization',
      resourceId: 'org_1',
      driveId: null,
      details: { changes: [{ key: 'guests', from: 'on', to: 'off' }] },
    });
    expect(row).toBe(`2026-10-01T12:00:00.000Z,policies,org.policy.changed,u1,'=evil,organization,org_1,,"{""changes"":[{""key"":""guests"",""from"":""on"",""to"":""off""}]}"`);
  });
});
