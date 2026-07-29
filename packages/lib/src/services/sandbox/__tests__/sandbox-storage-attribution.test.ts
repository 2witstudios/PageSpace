import { describe, it, expect } from 'vitest';
import { assert } from './riteway';
import { storageBillingTarget, type StorageSubject } from '../sandbox-storage-attribution';

describe('storageBillingTarget', () => {
  it('targets the backing agent page when agentPageId is set', () => {
    assert({
      given: 'an agent-session subject with a backing agent page',
      should: 'target that page',
      actual: storageBillingTarget({ sessionId: 'session-1', agentPageId: 'agent-page-1', ownerId: 'owner-1' }),
      expected: { pageId: 'agent-page-1' },
    });
  });

  it('targets the session ownerId directly when agentPageId is null (a global-assistant session)', () => {
    assert({
      given: 'a global-assistant agent-session subject (no backing page)',
      should: 'target the ownerId directly — no page to attribute to',
      actual: storageBillingTarget({ sessionId: 'session-1', agentPageId: null, ownerId: 'owner-1' }),
      expected: { ownerId: 'owner-1' },
    });
  });

  it('given the same subject twice, produces the same target', () => {
    const subject: StorageSubject = { sessionId: 'session-1', agentPageId: 'agent-page-1', ownerId: 'owner-1' };
    expect(storageBillingTarget(subject)).toEqual(storageBillingTarget({ ...subject }));
  });
});
