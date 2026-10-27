import { describe, it } from 'vitest';
import { assert } from '../../__tests__/riteway';
import { buildReceipts, type ReceiptInput } from '../siem-receipt-builder';
import type { AuditLogEntry, AuditLogSource } from '../siem-adapter';

const makeEntry = (overrides: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
  id: 'entry-1',
  source: 'activity_logs',
  timestamp: new Date('2026-04-10T12:00:00Z'),
  userId: null,
  actorEmail: 'a@b.com',
  actorDisplayName: null,
  isAiGenerated: false,
  aiProvider: null,
  aiModel: null,
  aiConversationId: null,
  operation: 'op',
  resourceType: 'page',
  resourceId: 'r1',
  resourceTitle: null,
  driveId: null,
  pageId: null,
  metadata: null,
  previousLogHash: null,
  logHash: null,
  ...overrides,
});

const baseInput = (overrides: Partial<ReceiptInput> = {}): ReceiptInput => ({
  deliveryId: 'delivery-xyz',
  deliveredAt: new Date('2026-04-10T12:05:00Z'),
  webhookStatus: 200,
  webhookResponseHash: 'abc123',
  ackReceivedAt: null,
  deliveredEntries: [],
  ...overrides,
});

describe('buildReceipts', () => {
  it('empty deliveredEntries returns empty array', () => {
    const receipts = buildReceipts(baseInput({ deliveredEntries: [] }));

    assert({
      given: 'an empty deliveredEntries array',
      should: 'return an empty array',
      actual: receipts,
      expected: [],
    });
  });

  it('single activity_logs entry returns one receipt', () => {
    const entry = makeEntry({ id: 'a1', source: 'activity_logs' });
    const receipts = buildReceipts(baseInput({ deliveredEntries: [entry] }));

    assert({
      given: 'one entry from activity_logs',
      should: 'return one receipt with entryCount 1 and first=last',
      actual: {
        length: receipts.length,
        count: receipts[0].entryCount,
        first: receipts[0].firstEntryId,
        last: receipts[0].lastEntryId,
      },
      expected: { length: 1, count: 1, first: 'a1', last: 'a1' },
    });
  });

  it('three interleaved entries (2 activity, 1 security) produce two per-source receipts', () => {
    const entries: AuditLogEntry[] = [
      makeEntry({ id: 'a1', source: 'activity_logs', timestamp: new Date('2026-04-10T12:00:00Z') }),
      makeEntry({ id: 's1', source: 'security_audit_log', timestamp: new Date('2026-04-10T12:01:00Z') }),
      makeEntry({ id: 'a2', source: 'activity_logs', timestamp: new Date('2026-04-10T12:02:00Z') }),
    ];

    const receipts = buildReceipts(baseInput({ deliveredEntries: entries }));
    const bySource = new Map<AuditLogSource, (typeof receipts)[number]>();
    for (const r of receipts) bySource.set(r.source, r);

    assert({
      given: 'three interleaved entries across two sources',
      should: 'produce per-source receipts with correct first/last and counts',
      actual: {
        total: receipts.length,
        activity: {
          first: bySource.get('activity_logs')?.firstEntryId,
          last: bySource.get('activity_logs')?.lastEntryId,
          count: bySource.get('activity_logs')?.entryCount,
        },
        security: {
          first: bySource.get('security_audit_log')?.firstEntryId,
          last: bySource.get('security_audit_log')?.lastEntryId,
          count: bySource.get('security_audit_log')?.entryCount,
        },
      },
      expected: {
        total: 2,
        activity: { first: 'a1', last: 'a2', count: 2 },
        security: { first: 's1', last: 's1', count: 1 },
      },
    });
  });

  it('single-source batch returns exactly one receipt', () => {
    const entries = [
      makeEntry({ id: 'a1', timestamp: new Date('2026-04-10T12:00:00Z') }),
      makeEntry({ id: 'a2', timestamp: new Date('2026-04-10T12:01:00Z') }),
      makeEntry({ id: 'a3', timestamp: new Date('2026-04-10T12:02:00Z') }),
    ];
    const receipts = buildReceipts(baseInput({ deliveredEntries: entries }));

    assert({
      given: 'a batch where all entries come from one source',
      should: 'return a single receipt',
      actual: { length: receipts.length, count: receipts[0].entryCount, source: receipts[0].source },
      expected: { length: 1, count: 3, source: 'activity_logs' },
    });
  });

  it('per-source boundaries use min/max within source, not batch boundaries', () => {
    // Interleaved order, but per-source min/max must ignore cross-source entries.
    const entries: AuditLogEntry[] = [
      makeEntry({ id: 's_early', source: 'security_audit_log', timestamp: new Date('2026-04-10T11:59:00Z') }),
      makeEntry({ id: 'a_mid', source: 'activity_logs', timestamp: new Date('2026-04-10T12:00:00Z') }),
      makeEntry({ id: 's_late', source: 'security_audit_log', timestamp: new Date('2026-04-10T12:03:00Z') }),
      makeEntry({ id: 'a_late', source: 'activity_logs', timestamp: new Date('2026-04-10T12:05:00Z') }),
    ];
    const receipts = buildReceipts(baseInput({ deliveredEntries: entries }));
    const bySource = new Map(receipts.map((r) => [r.source, r]));

    assert({
      given: 'first/last for a source',
      should: 'use min/max timestamps within that source',
      actual: {
        a_first: bySource.get('activity_logs')?.firstEntryId,
        a_last: bySource.get('activity_logs')?.lastEntryId,
        s_first: bySource.get('security_audit_log')?.firstEntryId,
        s_last: bySource.get('security_audit_log')?.lastEntryId,
      },
      expected: {
        a_first: 'a_mid',
        a_last: 'a_late',
        s_first: 's_early',
        s_last: 's_late',
      },
    });
  });

  it('stamps webhookStatus and responseHash on every returned receipt', () => {
    const entries: AuditLogEntry[] = [
      makeEntry({ id: 'a1', source: 'activity_logs' }),
      makeEntry({ id: 's1', source: 'security_audit_log' }),
    ];
    const receipts = buildReceipts(
      baseInput({
        deliveredEntries: entries,
        webhookStatus: 200,
        webhookResponseHash: 'hash-deadbeef',
      })
    );

    assert({
      given: 'a webhookStatus 200 and a non-null responseHash',
      should: 'carry them into every returned receipt',
      actual: receipts.every((r) => r.webhookStatus === 200 && r.webhookResponseHash === 'hash-deadbeef'),
      expected: true,
    });
  });

  it('null webhookStatus (syslog case) applies to every receipt', () => {
    const entries: AuditLogEntry[] = [
      makeEntry({ id: 'a1', source: 'activity_logs' }),
      makeEntry({ id: 's1', source: 'security_audit_log' }),
    ];
    const receipts = buildReceipts(
      baseInput({ deliveredEntries: entries, webhookStatus: null, webhookResponseHash: null })
    );

    assert({
      given: 'a null webhookStatus (syslog case)',
      should: 'set webhookStatus null and responseHash null on every receipt',
      actual: receipts.every((r) => r.webhookStatus === null && r.webhookResponseHash === null),
      expected: true,
    });
  });

  it('stamps deliveryId on every returned receipt', () => {
    const entries: AuditLogEntry[] = [
      makeEntry({ id: 'a1', source: 'activity_logs' }),
      makeEntry({ id: 's1', source: 'security_audit_log' }),
    ];
    const receipts = buildReceipts(
      baseInput({ deliveredEntries: entries, deliveryId: 'run-42' })
    );

    assert({
      given: 'a single deliveryId in input',
      should: 'stamp it on every returned receipt',
      actual: receipts.every((r) => r.deliveryId === 'run-42'),
      expected: true,
    });
  });
});
