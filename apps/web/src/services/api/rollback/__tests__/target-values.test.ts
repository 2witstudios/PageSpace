import { describe, it } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';
import type { ActivityLogForRollback } from '../../rollback-service';
import {
  getChangeDescription,
  buildChangeSummary,
  buildRollbackTargetValues,
  buildActionTargetValues,
  getEffectiveOperation,
  isRollingBackRollback,
} from '../target-values';

function makeActivity(overrides: Partial<ActivityLogForRollback> = {}): ActivityLogForRollback {
  return {
    id: 'act_1',
    timestamp: new Date('2024-01-01T00:00:00.000Z'),
    userId: 'user_1',
    actorEmail: 'a@b.c',
    actorDisplayName: null,
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
    contentFormat: null,
    contentSize: null,
    updatedFields: null,
    previousValues: null,
    newValues: null,
    metadata: null,
    streamId: null,
    streamSeq: null,
    changeGroupId: null,
    changeGroupType: null,
    stateHashBefore: null,
    stateHashAfter: null,
    rollbackFromActivityId: null,
    rollbackSourceOperation: null,
    rollbackSourceTimestamp: null,
    rollbackSourceTitle: null,
    ...overrides,
  };
}

describe('isRollingBackRollback', () => {
  it('is true for a rollback activity', () => {
    assert({
      given: 'an activity whose operation is rollback',
      should: 'return true',
      actual: isRollingBackRollback(makeActivity({ operation: 'rollback' })),
      expected: true,
    });
  });

  it('is false for a non-rollback activity', () => {
    assert({
      given: 'an activity whose operation is update',
      should: 'return false',
      actual: isRollingBackRollback(makeActivity({ operation: 'update' })),
      expected: false,
    });
  });
});

describe('getEffectiveOperation', () => {
  it('returns the source operation when rolling back a rollback', () => {
    assert({
      given: 'a rollback activity with a recorded source operation',
      should: 'return the source operation so the right handler runs',
      actual: getEffectiveOperation(makeActivity({ operation: 'rollback', rollbackSourceOperation: 'update' })),
      expected: 'update',
    });
  });

  it('returns null when a rollback activity has no source operation', () => {
    assert({
      given: 'a rollback activity with rollbackSourceOperation null',
      should: 'return null (not throw, not fall back)',
      actual: getEffectiveOperation(makeActivity({ operation: 'rollback', rollbackSourceOperation: null })),
      expected: null,
    });
  });

  it('returns the operation itself for a non-rollback activity', () => {
    assert({
      given: 'a regular update activity',
      should: 'return update',
      actual: getEffectiveOperation(makeActivity({ operation: 'update' })),
      expected: 'update',
    });
  });
});

describe('getChangeDescription', () => {
  it('prefers the resource title', () => {
    assert({
      given: 'an activity with a resource title',
      should: 'return the resource title',
      actual: getChangeDescription(makeActivity({ resourceTitle: 'My Page' })),
      expected: 'My Page',
    });
  });

  it('falls back to the target user email', () => {
    assert({
      given: 'no resource title but a targetUserEmail in metadata',
      should: 'return the email',
      actual: getChangeDescription(makeActivity({ resourceTitle: null, metadata: { targetUserEmail: 'x@y.z' } })),
      expected: 'x@y.z',
    });
  });

  it('falls back to the resource type', () => {
    assert({
      given: 'no resource title and no target email',
      should: 'return the resource type',
      actual: getChangeDescription(makeActivity({ resourceTitle: null, resourceType: 'drive', metadata: null })),
      expected: 'drive',
    });
  });
});

describe('buildRollbackTargetValues', () => {
  it('returns baseValues unchanged for a create with a snapshot present', () => {
    assert({
      given: 'a create operation with a content snapshot and previousValues',
      should: 'return baseValues unchanged (no content injection for create)',
      actual: buildRollbackTargetValues(
        makeActivity({ operation: 'create', previousValues: { x: 1 } }),
        'SNAPSHOT'
      ),
      expected: { x: 1 },
    });
  });

  it('returns null for a create with no previousValues', () => {
    assert({
      given: 'a create operation with null previousValues',
      should: 'return null',
      actual: buildRollbackTargetValues(makeActivity({ operation: 'create', previousValues: null }), 'SNAPSHOT'),
      expected: null,
    });
  });

  it('injects the resolved content snapshot when previousValues lacks content', () => {
    assert({
      given: 'an update whose previousValues has no content and a snapshot arg',
      should: 'add content from the snapshot',
      actual: buildRollbackTargetValues(
        makeActivity({ operation: 'update', previousValues: { title: 't' } }),
        'SNAPSHOT'
      ),
      expected: { title: 't', content: 'SNAPSHOT' },
    });
  });

  it('does NOT overwrite an existing content field with the snapshot', () => {
    assert({
      given: 'previousValues that already contains content',
      should: 'keep the existing content, ignoring the snapshot',
      actual: buildRollbackTargetValues(
        makeActivity({ operation: 'update', previousValues: { content: 'ORIGINAL' } }),
        'SNAPSHOT'
      ),
      expected: { content: 'ORIGINAL' },
    });
  });

  it('injects content into an empty base when previousValues is null', () => {
    assert({
      given: 'an update with null previousValues and a snapshot',
      should: 'return an object with just the snapshot content',
      actual: buildRollbackTargetValues(
        makeActivity({ operation: 'update', previousValues: null }),
        'SNAPSHOT'
      ),
      expected: { content: 'SNAPSHOT' },
    });
  });

  it('falls back to activity.contentSnapshot when no snapshot arg is given', () => {
    assert({
      given: 'no snapshot argument but activity.contentSnapshot set',
      should: 'inject the activity content snapshot',
      actual: buildRollbackTargetValues(
        makeActivity({ operation: 'update', previousValues: { title: 't' }, contentSnapshot: 'FROM_ACTIVITY' })
      ),
      expected: { title: 't', content: 'FROM_ACTIVITY' },
    });
  });

  it('returns baseValues unchanged when there is no content anywhere', () => {
    assert({
      given: 'an update with previousValues and no snapshot',
      should: 'return the base values as-is',
      actual: buildRollbackTargetValues(
        makeActivity({ operation: 'update', previousValues: { title: 't' } })
      ),
      expected: { title: 't' },
    });
  });
});

describe('buildActionTargetValues', () => {
  it('uses previousValues directly when rolling back a rollback', () => {
    assert({
      given: 'a rollback activity with previousValues',
      should: 'return a copy of previousValues',
      actual: buildActionTargetValues(makeActivity({ operation: 'rollback', previousValues: { a: 1 } }), 'SNAP'),
      expected: { a: 1 },
    });
  });

  it('returns null when rolling back a rollback with no previousValues', () => {
    assert({
      given: 'a rollback activity with null previousValues',
      should: 'return null',
      actual: buildActionTargetValues(makeActivity({ operation: 'rollback', previousValues: null }), 'SNAP'),
      expected: null,
    });
  });

  it('delegates to rollback target shaping for a non-rollback activity', () => {
    assert({
      given: 'a regular update activity',
      should: 'shape target values like buildRollbackTargetValues',
      actual: buildActionTargetValues(makeActivity({ operation: 'update', previousValues: { title: 't' } }), 'SNAP'),
      expected: { title: 't', content: 'SNAP' },
    });
  });
});

describe('buildChangeSummary', () => {
  it('uses updatedFields when present', () => {
    assert({
      given: 'an activity with updatedFields',
      should: 'set fields to the updated fields',
      actual: buildChangeSummary(makeActivity({ operation: 'update', updatedFields: ['title'] }), null)[0].fields,
      expected: ['title'],
    });
  });

  it('falls back to target-value keys when updatedFields is empty', () => {
    assert({
      given: 'no updatedFields but target values present',
      should: 'set fields to the target-value keys',
      actual: buildChangeSummary(makeActivity({ operation: 'update', updatedFields: [] }), { title: 't', position: 1 })[0].fields,
      expected: ['title', 'position'],
    });
  });

  it('leaves fields undefined when nothing is available', () => {
    assert({
      given: 'no updatedFields and no target values',
      should: 'leave fields undefined',
      actual: buildChangeSummary(makeActivity({ operation: 'update', updatedFields: null }), null)[0].fields,
      expected: undefined,
    });
  });

  it('labels the summary with an Undo prefix', () => {
    assert({
      given: 'an update activity',
      should: 'produce an "Undo Update" label',
      actual: buildChangeSummary(makeActivity({ operation: 'update' }), null)[0].label,
      expected: 'Undo Update',
    });
  });

  it('carries the resource identity into the summary', () => {
    assert({
      given: 'an activity for page_1 titled Title',
      should: 'embed the resource type, id, and title',
      actual: buildChangeSummary(makeActivity(), null)[0].resource,
      expected: { type: 'page', id: 'page_1', title: 'Title' },
    });
  });
});
