import { describe, it, vi } from 'vitest';
import { assert } from '@/stores/__tests__/riteway';

vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/db/schema/monitoring', () => ({ activityLogs: { id: 'id', pageId: 'pageId', driveId: 'driveId', timestamp: 'timestamp', userId: 'userId', operation: 'operation', isAiGenerated: 'isAiGenerated', resourceType: 'resourceType' } }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', subscriptionTier: 'subscriptionTier' } }));

import { getActivityById, getUserRetentionDays, getPageVersionHistory } from '../activity-repo';
import type { RollbackDeps } from '../deps';

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

function depsWith(db: unknown): RollbackDeps {
  return {
    db,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as RollbackDeps;
}

const throwingDb = {
  select: () => { throw new Error('db down'); },
} as unknown as RollbackDeps['db'];

describe('getActivityById (DI shell)', () => {
  it('maps a found row', async () => {
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([activityRow()]) }) }) }) };
    const result = await getActivityById(depsWith(db), 'act_1');
    assert({ given: 'a matching activity row', should: 'return the mapped activity id', actual: result?.id, expected: 'act_1' });
  });

  it('returns null when no row is found', async () => {
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }) };
    const result = await getActivityById(depsWith(db), 'missing');
    assert({ given: 'no matching row', should: 'return null', actual: result, expected: null });
  });

  it('swallows a DB error and returns null', async () => {
    const result = await getActivityById(depsWith(throwingDb), 'act_1');
    assert({ given: 'a failing database', should: 'return null rather than throw', actual: result, expected: null });
  });
});

describe('getUserRetentionDays (DI shell)', () => {
  it('maps a subscription tier to its retention days', async () => {
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ subscriptionTier: 'pro' }]) }) }) }) };
    assert({ given: 'a pro-tier user', should: 'return 30 days', actual: await getUserRetentionDays(depsWith(db), 'u'), expected: 30 });
  });

  it('defaults to free when the user is missing', async () => {
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }) };
    assert({ given: 'no user row', should: 'return the free retention (7)', actual: await getUserRetentionDays(depsWith(db), 'u'), expected: 7 });
  });

  it('defaults to free retention on a DB error', async () => {
    assert({ given: 'a failing database', should: 'return the free retention (7)', actual: await getUserRetentionDays(depsWith(throwingDb), 'u'), expected: 7 });
  });
});

describe('getPageVersionHistory (DI shell)', () => {
  it('returns an empty history on a DB error rather than throwing', async () => {
    const result = await getPageVersionHistory(depsWith(throwingDb), 'page_1', 'u');
    assert({ given: 'a failing database', should: 'return an empty history', actual: result, expected: { activities: [], total: 0 } });
  });
});
