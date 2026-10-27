/**
 * The invalidation's failure containment (ARCH-2): the transition has already committed, so
 * no downstream failure — a lost drive row, a policy read outage, a failed audience read —
 * may reject the caller or leave the publish half-done loudly. Everything is contained:
 * the failure is logged, the rest of the delta still ships.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.REALTIME_BROADCAST_SECRET = process.env.REALTIME_BROADCAST_SECRET || 'test-realtime-broadcast-secret-32-chars-minimum-length';

const dbState = vi.hoisted(() => ({ failSelect: false }));
const audienceState = vi.hoisted(() => ({ fail: false, rows: [] as Array<{ userId: string; source: string }> }));

vi.mock('@pagespace/db/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/db/db')>();
  const realSelect = actual.db.select.bind(actual.db);
  return {
    db: {
      select: (...args: unknown[]) => {
        if (dbState.failSelect) throw new Error('db down');
        return realSelect(...args as []);
      },
    },
    pool: actual.pool,
  };
});

vi.mock('../../permissions/drive-audience', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../permissions/drive-audience')>();
  return {
    ...actual,
    listDriveAudience: (driveId: string) => {
      if (audienceState.fail) throw new Error('audience read failed');
      return actual.listDriveAudience(driveId);
    },
  };
});

import { publishDriveTransitionInvalidation } from '../drive-transition-invalidation';

beforeEach(() => {
  dbState.failSelect = false;
  audienceState.fail = false;
  audienceState.rows = [];
});

describe('publishDriveTransitionInvalidation contains its own failures', () => {
  it('a lost drive row still kicks the whole before-audience: nothing accesses a drive that no longer exists', async () => {
    const kicks: Array<{ userId: string; driveId: string }> = [];
    const broadcasts: string[] = [];
    await publishDriveTransitionInvalidation({
      driveId: 'drive-gone',
      orgIdBefore: 'org-1',
      orgIdAfter: 'org-1',
      audienceBefore: ['u-1', 'u-2'],
      ports: {
        kick: async (target) => { kicks.push(target); },
        broadcast: async (user) => { broadcasts.push(user.userId); },
      },
    });
    expect(kicks).toEqual([{ userId: 'u-1', driveId: 'drive-gone' }, { userId: 'u-2', driveId: 'drive-gone' }]);
    expect(broadcasts).toEqual([]);
  });

  it('an audience read outage is logged and contained — the publish resolves, it does not reject', async () => {
    audienceState.fail = true;
    await expect(publishDriveTransitionInvalidation({
      driveId: 'drive-live',
      orgIdBefore: null,
      orgIdAfter: null,
      audienceBefore: ['u-1'],
      ports: {
        kick: async () => {},
        broadcast: async () => {},
      },
    })).resolves.toBeUndefined();
  });
  it('a lost drive row is contained even when the database itself is unreachable', async () => {
    dbState.failSelect = true;
    await expect(publishDriveTransitionInvalidation({
      driveId: 'drive-x',
      orgIdBefore: null,
      orgIdAfter: null,
      audienceBefore: [],
      ports: { kick: async () => {}, broadcast: async () => {} },
    })).resolves.toBeUndefined();
  });
});
