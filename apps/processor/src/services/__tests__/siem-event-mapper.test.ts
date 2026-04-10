import { describe, it } from 'vitest';
import { assert } from '../../__tests__/riteway';
import { mapActivityLogToSiemEntry, mapActivityLogsToSiemEntries, type ActivityLogSiemRow } from '../siem-event-mapper';

const makeActivityLogRow = (overrides: Partial<ActivityLogSiemRow> = {}): ActivityLogSiemRow => ({
  id: 'log_abc123',
  timestamp: new Date('2026-04-10T12:00:00Z'),
  userId: 'user_001',
  actorEmail: 'alice@example.com',
  actorDisplayName: 'Alice Smith',
  isAiGenerated: false,
  aiProvider: null,
  aiModel: null,
  aiConversationId: null,
  operation: 'page.create',
  resourceType: 'page',
  resourceId: 'page_xyz',
  resourceTitle: 'My Document',
  driveId: 'drive_001',
  pageId: 'page_xyz',
  metadata: { source: 'web' },
  previousLogHash: 'abc123hash',
  logHash: 'def456hash',
  ...overrides,
});

describe('mapActivityLogToSiemEntry', () => {
  it('complete row mapping', () => {
    const row = makeActivityLogRow();
    const entry = mapActivityLogToSiemEntry(row);

    assert({
      given: 'a complete activity_logs row',
      should: 'map id correctly',
      actual: entry.id,
      expected: 'log_abc123',
    });

    assert({
      given: 'a complete activity_logs row',
      should: 'map timestamp as Date',
      actual: entry.timestamp instanceof Date,
      expected: true,
    });

    assert({
      given: 'a complete activity_logs row',
      should: 'map userId',
      actual: entry.userId,
      expected: 'user_001',
    });

    assert({
      given: 'a complete activity_logs row',
      should: 'map actorEmail',
      actual: entry.actorEmail,
      expected: 'alice@example.com',
    });

    assert({
      given: 'a complete activity_logs row',
      should: 'map actorDisplayName',
      actual: entry.actorDisplayName,
      expected: 'Alice Smith',
    });

    assert({
      given: 'a complete activity_logs row',
      should: 'map operation as string',
      actual: entry.operation,
      expected: 'page.create',
    });

    assert({
      given: 'a complete activity_logs row',
      should: 'map resourceType as string',
      actual: entry.resourceType,
      expected: 'page',
    });

    assert({
      given: 'a complete activity_logs row',
      should: 'map resourceId',
      actual: entry.resourceId,
      expected: 'page_xyz',
    });

    assert({
      given: 'a complete activity_logs row',
      should: 'map resourceTitle',
      actual: entry.resourceTitle,
      expected: 'My Document',
    });

    assert({
      given: 'a complete activity_logs row',
      should: 'map driveId',
      actual: entry.driveId,
      expected: 'drive_001',
    });

    assert({
      given: 'a complete activity_logs row',
      should: 'map pageId',
      actual: entry.pageId,
      expected: 'page_xyz',
    });

    assert({
      given: 'a complete activity_logs row',
      should: 'map metadata',
      actual: entry.metadata,
      expected: { source: 'web' },
    });

    assert({
      given: 'a complete activity_logs row',
      should: 'map previousLogHash',
      actual: entry.previousLogHash,
      expected: 'abc123hash',
    });

    assert({
      given: 'a complete activity_logs row',
      should: 'map logHash',
      actual: entry.logHash,
      expected: 'def456hash',
    });
  });

  it('null optional fields', () => {
    const row = makeActivityLogRow({
      userId: null,
      actorDisplayName: null,
      resourceTitle: null,
      driveId: null,
      pageId: null,
      metadata: null,
      previousLogHash: null,
      logHash: null,
    });
    const entry = mapActivityLogToSiemEntry(row);

    assert({
      given: 'null optional fields',
      should: 'pass userId as null',
      actual: entry.userId,
      expected: null,
    });

    assert({
      given: 'null optional fields',
      should: 'pass actorDisplayName as null',
      actual: entry.actorDisplayName,
      expected: null,
    });

    assert({
      given: 'null optional fields',
      should: 'pass resourceTitle as null',
      actual: entry.resourceTitle,
      expected: null,
    });

    assert({
      given: 'null optional fields',
      should: 'pass metadata as null',
      actual: entry.metadata,
      expected: null,
    });
  });

  it('AI-generated entry', () => {
    const row = makeActivityLogRow({
      isAiGenerated: true,
      aiProvider: 'anthropic',
      aiModel: 'claude-sonnet-4-6',
      aiConversationId: 'conv_999',
    });
    const entry = mapActivityLogToSiemEntry(row);

    assert({
      given: 'an AI-generated entry',
      should: 'preserve isAiGenerated',
      actual: entry.isAiGenerated,
      expected: true,
    });

    assert({
      given: 'an AI-generated entry',
      should: 'preserve aiProvider',
      actual: entry.aiProvider,
      expected: 'anthropic',
    });

    assert({
      given: 'an AI-generated entry',
      should: 'preserve aiModel',
      actual: entry.aiModel,
      expected: 'claude-sonnet-4-6',
    });

    assert({
      given: 'an AI-generated entry',
      should: 'preserve aiConversationId',
      actual: entry.aiConversationId,
      expected: 'conv_999',
    });
  });

  it('string timestamp coercion', () => {
    const row = makeActivityLogRow({
      timestamp: '2026-04-10T12:00:00Z',
    });
    const entry = mapActivityLogToSiemEntry(row);

    assert({
      given: 'a string timestamp from DB',
      should: 'coerce to Date object',
      actual: entry.timestamp instanceof Date,
      expected: true,
    });

    assert({
      given: 'a string timestamp from DB',
      should: 'preserve the time value',
      actual: entry.timestamp.toISOString(),
      expected: '2026-04-10T12:00:00.000Z',
    });
  });
});

describe('mapActivityLogsToSiemEntries', () => {
  it('batch mapping', () => {
    const rows = [
      makeActivityLogRow({ id: 'log_1' }),
      makeActivityLogRow({ id: 'log_2' }),
      makeActivityLogRow({ id: 'log_3' }),
    ];
    const entries = mapActivityLogsToSiemEntries(rows);

    assert({
      given: 'a batch of 3 rows',
      should: 'return 3 entries',
      actual: entries.length,
      expected: 3,
    });

    assert({
      given: 'a batch of rows',
      should: 'preserve order by mapping first id',
      actual: entries[0].id,
      expected: 'log_1',
    });

    assert({
      given: 'a batch of rows',
      should: 'preserve order by mapping last id',
      actual: entries[2].id,
      expected: 'log_3',
    });
  });

  it('empty batch', () => {
    const entries = mapActivityLogsToSiemEntries([]);

    assert({
      given: 'an empty array',
      should: 'return empty array',
      actual: entries.length,
      expected: 0,
    });
  });
});
