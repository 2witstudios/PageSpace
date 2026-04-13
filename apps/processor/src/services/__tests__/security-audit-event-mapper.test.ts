import { describe, it, expect } from 'vitest';
import { assert } from '../../__tests__/riteway';
import {
  mapSecurityAuditToSiemEntry,
  mapSecurityAuditEventsToSiemEntries,
  type SecurityAuditSiemRow,
} from '../security-audit-event-mapper';

const makeSecurityAuditRow = (
  overrides: Partial<SecurityAuditSiemRow> = {}
): SecurityAuditSiemRow => ({
  id: 'sec_abc123',
  timestamp: new Date('2026-04-10T12:00:00Z'),
  eventType: 'auth.login.success',
  userId: 'user_001',
  sessionId: 'sess_001',
  serviceId: null,
  resourceType: 'session',
  resourceId: 'sess_001',
  ipAddress: '203.0.113.5',
  userAgent: 'Mozilla/5.0',
  geoLocation: 'US-CA',
  details: { method: 'password' },
  riskScore: 0.12,
  anomalyFlags: ['new_device'],
  previousHash: 'genesis',
  eventHash: 'hash_def456',
  ...overrides,
});

describe('mapSecurityAuditToSiemEntry', () => {
  it('maps a complete row to AuditLogEntry shape', () => {
    const row = makeSecurityAuditRow();
    const entry = mapSecurityAuditToSiemEntry(row);

    assert({
      given: 'a complete security_audit_log row',
      should: 'preserve id',
      actual: entry.id,
      expected: 'sec_abc123',
    });

    assert({
      given: 'a complete security_audit_log row',
      should: "stamp source as 'security_audit_log'",
      actual: entry.source,
      expected: 'security_audit_log',
    });

    assert({
      given: 'a complete security_audit_log row',
      should: 'expose timestamp as a Date',
      actual: entry.timestamp instanceof Date,
      expected: true,
    });

    assert({
      given: 'a complete security_audit_log row',
      should: 'use eventType as the operation field',
      actual: entry.operation,
      expected: 'auth.login.success',
    });

    assert({
      given: 'a complete security_audit_log row',
      should: 'preserve userId',
      actual: entry.userId,
      expected: 'user_001',
    });

    assert({
      given: 'a complete security_audit_log row',
      should: 'project resourceType',
      actual: entry.resourceType,
      expected: 'session',
    });

    assert({
      given: 'a complete security_audit_log row',
      should: 'project resourceId',
      actual: entry.resourceId,
      expected: 'sess_001',
    });
  });

  it('preserves the hash chain fields under integrity-friendly names', () => {
    const row = makeSecurityAuditRow({
      previousHash: 'prev_hash_aaa',
      eventHash: 'event_hash_bbb',
    });
    const entry = mapSecurityAuditToSiemEntry(row);

    assert({
      given: 'a row with previousHash',
      should: 'expose it as previousLogHash',
      actual: entry.previousLogHash,
      expected: 'prev_hash_aaa',
    });

    assert({
      given: 'a row with eventHash',
      should: 'expose it as logHash',
      actual: entry.logHash,
      expected: 'event_hash_bbb',
    });
  });

  it('preserves riskScore and anomalyFlags inside metadata', () => {
    const row = makeSecurityAuditRow({
      riskScore: 0.87,
      anomalyFlags: ['new_device', 'impossible_travel'],
      details: { method: 'webauthn' },
    });
    const entry = mapSecurityAuditToSiemEntry(row);

    expect(entry.metadata).toMatchObject({
      details: { method: 'webauthn' },
      riskScore: 0.87,
      anomalyFlags: ['new_device', 'impossible_travel'],
    });
  });

  it('handles null PII fields without throwing', () => {
    const row = makeSecurityAuditRow({
      userId: null,
      sessionId: null,
      ipAddress: null,
      userAgent: null,
      geoLocation: null,
    });
    const entry = mapSecurityAuditToSiemEntry(row);

    assert({
      given: 'null userId',
      should: 'pass through as null',
      actual: entry.userId,
      expected: null,
    });

    assert({
      given: 'no PII fields',
      should: 'still produce a stamped entry with source security_audit_log',
      actual: entry.source,
      expected: 'security_audit_log',
    });
  });

  it('coerces string timestamps into Date instances', () => {
    const row = makeSecurityAuditRow({ timestamp: '2026-04-10T12:00:00Z' });
    const entry = mapSecurityAuditToSiemEntry(row);

    assert({
      given: 'a string timestamp from the DB driver',
      should: 'be coerced into a Date instance',
      actual: entry.timestamp instanceof Date,
      expected: true,
    });

    assert({
      given: 'a string timestamp from the DB driver',
      should: 'preserve the time value',
      actual: entry.timestamp.toISOString(),
      expected: '2026-04-10T12:00:00.000Z',
    });
  });

  it('throws on an invalid timestamp', () => {
    const row = makeSecurityAuditRow({ timestamp: 'not-a-date' });
    expect(() => mapSecurityAuditToSiemEntry(row)).toThrow(/security_audit_log timestamp/);
  });

  it('maps a variety of security event types as the operation field', () => {
    const eventTypes = [
      'auth.login.success',
      'auth.login.failure',
      'data.read',
      'data.write',
      'data.delete',
      'security.anomaly.detected',
    ] as const;

    for (const eventType of eventTypes) {
      const row = makeSecurityAuditRow({ eventType });
      const entry = mapSecurityAuditToSiemEntry(row);
      assert({
        given: `event type ${eventType}`,
        should: 'be mirrored into the operation field',
        actual: entry.operation,
        expected: eventType,
      });
    }
  });

  it('reports security_audit_log as the resourceType when the row has no target', () => {
    const row = makeSecurityAuditRow({ resourceType: null, resourceId: null });
    const entry = mapSecurityAuditToSiemEntry(row);

    assert({
      given: 'a security event with no target resource',
      should: "fall back to 'security_audit_log' as the resourceType",
      actual: entry.resourceType,
      expected: 'security_audit_log',
    });

    assert({
      given: 'a security event with no target resource',
      should: 'fall back to the row id as the resourceId',
      actual: entry.resourceId,
      expected: 'sec_abc123',
    });
  });
});

describe('mapSecurityAuditEventsToSiemEntries', () => {
  it('returns an empty array for an empty batch', () => {
    assert({
      given: 'an empty array',
      should: 'return an empty array',
      actual: mapSecurityAuditEventsToSiemEntries([]).length,
      expected: 0,
    });
  });

  it('preserves order across a mixed-event-type batch', () => {
    const rows = [
      makeSecurityAuditRow({ id: 'sec_1', eventType: 'auth.login.success' }),
      makeSecurityAuditRow({ id: 'sec_2', eventType: 'data.write' }),
      makeSecurityAuditRow({ id: 'sec_3', eventType: 'security.anomaly.detected' }),
    ];

    const entries = mapSecurityAuditEventsToSiemEntries(rows);

    assert({
      given: 'a batch of 3 rows',
      should: 'return 3 entries',
      actual: entries.length,
      expected: 3,
    });

    assert({
      given: 'a batch of mixed events',
      should: 'preserve order by id (first)',
      actual: entries[0].id,
      expected: 'sec_1',
    });

    assert({
      given: 'a batch of mixed events',
      should: 'preserve order by id (last)',
      actual: entries[2].id,
      expected: 'sec_3',
    });

    assert({
      given: 'a batch of mixed events',
      should: 'stamp every entry with source security_audit_log',
      actual: entries.every((e) => e.source === 'security_audit_log'),
      expected: true,
    });
  });
});
