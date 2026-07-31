import { describe, it, expect } from 'vitest';
import { assert } from './riteway';
import { storageBillingTarget, type StorageSubject } from '../sandbox-storage-attribution';

describe('storageBillingTarget', () => {
  it('targets the drive when driveId is set — a session is a drive-level workspace', () => {
    assert({
      given: 'a drive-scoped agent-session subject',
      should: 'target that drive (its owner pays)',
      actual: storageBillingTarget({ sessionId: 'session-1', driveId: 'drive-1', ownerId: 'owner-1' }),
      expected: { driveId: 'drive-1' },
    });
  });

  it('targets the session ownerId directly when driveId is null (a global-assistant session)', () => {
    assert({
      given: 'a global-assistant agent-session subject (no drive)',
      should: 'target the ownerId directly — no drive to attribute to',
      actual: storageBillingTarget({ sessionId: 'session-1', driveId: null, ownerId: 'owner-1' }),
      expected: { ownerId: 'owner-1' },
    });
  });

  it('given the same subject twice, produces the same target', () => {
    const subject: StorageSubject = { sessionId: 'session-1', driveId: 'drive-1', ownerId: 'owner-1' };
    expect(storageBillingTarget(subject)).toEqual(storageBillingTarget({ ...subject }));
  });
});
