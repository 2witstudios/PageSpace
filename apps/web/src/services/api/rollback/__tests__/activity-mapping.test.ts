import { describe, it } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import { eq } from '@pagespace/db/operators';
import { mapActivityRow, buildHistoryConditions, type ActivityRow } from '../activity-mapping';

function makeRow(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 'act_1',
    timestamp: new Date('2024-01-01T00:00:00.000Z'),
    userId: 'user_1',
    actorEmail: 'a@b.c',
    actorDisplayName: 'Ann',
    operation: 'update',
    resourceType: 'page',
    resourceId: 'page_1',
    resourceTitle: 'Title',
    driveId: 'drive_1',
    pageId: 'page_1',
    isAiGenerated: false,
    aiProvider: null,
    aiModel: null,
    contentSnapshot: null,
    contentRef: null,
    contentFormat: 'html',
    contentSize: 12,
    updatedFields: ['title'],
    previousValues: { title: 'old' },
    newValues: { title: 'new' },
    metadata: { targetUserEmail: 'x@y.z' },
    streamId: 'stream_1',
    streamSeq: 3,
    changeGroupId: 'cg_1',
    changeGroupType: 'user_edit',
    stateHashBefore: 'hashA',
    stateHashAfter: 'hashB',
    rollbackFromActivityId: null,
    rollbackSourceOperation: null,
    rollbackSourceTimestamp: null,
    rollbackSourceTitle: null,
    ...overrides,
  } as ActivityRow;
}

describe('mapActivityRow', () => {
  it('maps a raw activity row to the ActivityLogForRollback shape', () => {
    assert({
      given: 'a raw activityLogs row',
      should: 'produce the full ActivityLogForRollback object',
      actual: mapActivityRow(makeRow()),
      expected: {
        id: 'act_1',
        timestamp: new Date('2024-01-01T00:00:00.000Z'),
        userId: 'user_1',
        actorEmail: 'a@b.c',
        actorDisplayName: 'Ann',
        operation: 'update',
        resourceType: 'page',
        resourceId: 'page_1',
        resourceTitle: 'Title',
        driveId: 'drive_1',
        pageId: 'page_1',
        isAiGenerated: false,
        aiProvider: null,
        aiModel: null,
        contentSnapshot: null,
        contentRef: null,
        contentFormat: 'html',
        contentSize: 12,
        updatedFields: ['title'],
        previousValues: { title: 'old' },
        newValues: { title: 'new' },
        metadata: { targetUserEmail: 'x@y.z' },
        streamId: 'stream_1',
        streamSeq: 3,
        changeGroupId: 'cg_1',
        changeGroupType: 'user_edit',
        stateHashBefore: 'hashA',
        stateHashAfter: 'hashB',
        rollbackFromActivityId: null,
        rollbackSourceOperation: null,
        rollbackSourceTimestamp: null,
        rollbackSourceTitle: null,
      },
    });
  });

  it('carries a nullable content format through unchanged', () => {
    assert({
      given: 'a row with a null content format',
      should: 'map contentFormat to null',
      actual: mapActivityRow(makeRow({ contentFormat: null })).contentFormat,
      expected: null,
    });
  });
});

describe('buildHistoryConditions', () => {
  const base = eq(activityLogs.pageId, 'page_1');

  it('returns just the base condition when no filters are given', () => {
    assert({
      given: 'no optional filters',
      should: 'return only the base condition',
      actual: buildHistoryConditions(base, {}).length,
      expected: 1,
    });
  });

  it('adds a start-date bound', () => {
    assert({
      given: 'a startDate filter',
      should: 'add one condition',
      actual: buildHistoryConditions(base, { startDate: new Date('2024-01-01') }).length,
      expected: 2,
    });
  });

  it('adds an end-date bound', () => {
    assert({
      given: 'an endDate filter',
      should: 'add one condition',
      actual: buildHistoryConditions(base, { endDate: new Date('2024-02-01') }).length,
      expected: 2,
    });
  });

  it('adds an actor filter', () => {
    assert({
      given: 'an actorId filter',
      should: 'add one condition',
      actual: buildHistoryConditions(base, { actorId: 'user_9' }).length,
      expected: 2,
    });
  });

  it('adds a valid operation filter', () => {
    assert({
      given: 'a valid operation filter',
      should: 'add one condition',
      actual: buildHistoryConditions(base, { operation: 'update' }).length,
      expected: 2,
    });
  });

  it('ignores an invalid operation filter', () => {
    assert({
      given: 'an operation string that is not a valid operation',
      should: 'not add a condition',
      actual: buildHistoryConditions(base, { operation: 'not_an_op' }).length,
      expected: 1,
    });
  });

  it('adds an AI-only filter', () => {
    assert({
      given: 'includeAiOnly true',
      should: 'add one condition',
      actual: buildHistoryConditions(base, { includeAiOnly: true }).length,
      expected: 2,
    });
  });

  it('adds a resource-type filter', () => {
    assert({
      given: 'a resourceType filter',
      should: 'add one condition',
      actual: buildHistoryConditions(base, { resourceType: 'page' }).length,
      expected: 2,
    });
  });

  it('combines every filter', () => {
    assert({
      given: 'all optional filters at once',
      should: 'add one condition per filter on top of the base',
      actual: buildHistoryConditions(base, {
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-02-01'),
        actorId: 'user_9',
        operation: 'update',
        includeAiOnly: true,
        resourceType: 'page',
      }).length,
      expected: 7,
    });
  });
});
