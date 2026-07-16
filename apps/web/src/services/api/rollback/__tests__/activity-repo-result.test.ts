import { describe, it, vi } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';

vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/db/schema/monitoring', () => ({ activityLogs: { id: 'id', pageId: 'pageId', driveId: 'driveId', timestamp: 'timestamp', userId: 'userId', operation: 'operation', isAiGenerated: 'isAiGenerated', resourceType: 'resourceType' } }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', subscriptionTier: 'subscriptionTier' } }));

import {
  loadActivityById,
  loadPageVersionHistory,
  loadUserRetentionDays,
  getPageVersionHistory,
} from '../activity-repo';
import type { RollbackDeps } from '../deps';

function depsWith(db: unknown): RollbackDeps {
  return { db, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } as unknown as RollbackDeps;
}

const throwingDb = { select: () => { throw new Error('db down'); } } as unknown as RollbackDeps['db'];

function activityRow() {
  return {
    id: 'act_1', timestamp: new Date('2024-01-01T00:00:00.000Z'), userId: 'u', actorEmail: 'e',
    actorDisplayName: null, operation: 'update', resourceType: 'page', resourceId: 'page_1',
    resourceTitle: null, driveId: 'd', pageId: 'page_1', isAiGenerated: false, aiProvider: null,
    aiModel: null, contentSnapshot: null, contentRef: null, contentFormat: null, contentSize: null,
    updatedFields: null, previousValues: null, newValues: null, metadata: null, streamId: null,
    streamSeq: null, changeGroupId: null, changeGroupType: null, stateHashBefore: null,
    stateHashAfter: null, rollbackFromActivityId: null, rollbackSourceOperation: null,
    rollbackSourceTimestamp: null, rollbackSourceTitle: null,
  };
}

describe('loadActivityById (explicit Result)', () => {
  it('returns ok with the mapped row when found', async () => {
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([activityRow()]) }) }) }) };
    const r = await loadActivityById(depsWith(db), 'act_1');
    assert({ given: 'a found row', should: 'return ok with the mapped activity', actual: r.ok ? r.value?.id : `err:${r.error}`, expected: 'act_1' });
  });

  it('returns ok with null when the activity does not exist', async () => {
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }) };
    const r = await loadActivityById(depsWith(db), 'missing');
    assert({ given: 'no matching row', should: 'return ok with null (found nothing, not a failure)', actual: r, expected: { ok: true, value: null } });
  });

  it('returns an error result on a DB failure', async () => {
    const r = await loadActivityById(depsWith(throwingDb), 'act_1');
    assert({ given: 'a failing database', should: 'return ok:false', actual: r.ok, expected: false });
  });
});

describe('loadPageVersionHistory (explicit Result)', () => {
  it('distinguishes an empty history (ok) from a failing database (error)', async () => {
    const emptyDb = {
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ offset: () => Promise.resolve([]) }) }) }) }) }),
    };
    // count query path also resolves from the same chain shape
    const emptyDbWithCount = {
      select: (arg?: unknown) => arg
        ? ({ from: () => ({ where: () => Promise.resolve([{ value: 0 }]) }) })
        : ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ offset: () => Promise.resolve([]) }) }) }) }) }),
    };
    const okResult = await loadPageVersionHistory(depsWith(emptyDbWithCount), 'page_1', 'u');
    const errResult = await loadPageVersionHistory(depsWith(throwingDb), 'page_1', 'u');
    void emptyDb;
    assert({
      given: 'an empty history vs a failing database',
      should: 'return ok (empty) vs error, never conflating them',
      actual: { ok: okResult.ok, okValue: okResult.ok ? okResult.value : null, errOk: errResult.ok },
      expected: { ok: true, okValue: { activities: [], total: 0 }, errOk: false },
    });
  });
});

describe('loadUserRetentionDays (explicit Result)', () => {
  it('returns ok with the tier retention', async () => {
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ subscriptionTier: 'founder' }]) }) }) }) };
    const r = await loadUserRetentionDays(depsWith(db), 'u');
    assert({ given: 'a founder-tier user', should: 'return ok with 90', actual: r, expected: { ok: true, value: 90 } });
  });

  it('returns an error result on a DB failure', async () => {
    const r = await loadUserRetentionDays(depsWith(throwingDb), 'u');
    assert({ given: 'a failing database', should: 'return ok:false', actual: r.ok, expected: false });
  });
});

describe('legacy barrel contract preserved', () => {
  it('getPageVersionHistory still returns an empty history on a DB failure', async () => {
    const result = await getPageVersionHistory(depsWith(throwingDb), 'page_1', 'u');
    assert({ given: 'a failing database via the legacy wrapper', should: 'return the empty-history contract', actual: result, expected: { activities: [], total: 0 } });
  });
});
