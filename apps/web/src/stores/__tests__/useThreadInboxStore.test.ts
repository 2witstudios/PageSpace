import { describe, it, beforeEach } from 'vitest';
import { assert } from './riteway';
import { useThreadInboxStore } from '../useThreadInboxStore';

const reset = () => {
  useThreadInboxStore.setState({ contexts: {} });
};

describe('useThreadInboxStore', () => {
  beforeEach(reset);

  it('contributes one badge per distinct root after bump', () => {
    useThreadInboxStore.getState().bump({ source: 'channel', contextId: 'c1', rootMessageId: 'r1' });
    assert({
      given: 'a single bump for one root',
      should: 'report a context unread count of 1',
      actual: useThreadInboxStore.getState().contextUnreadCount('channel', 'c1'),
      expected: 1,
    });
  });

  it('keys by (source, contextId, rootMessageId) — same channel can carry multiple unread roots', () => {
    useThreadInboxStore.getState().bump({ source: 'channel', contextId: 'c1', rootMessageId: 'r1' });
    useThreadInboxStore.getState().bump({ source: 'channel', contextId: 'c1', rootMessageId: 'r2' });
    assert({
      given: 'bumps for two distinct roots in the same channel',
      should: 'count both roots toward the channel badge',
      actual: useThreadInboxStore.getState().contextUnreadCount('channel', 'c1'),
      expected: 2,
    });
  });

  it('clearing one root leaves siblings in the same context untouched', () => {
    useThreadInboxStore.getState().bump({ source: 'channel', contextId: 'c1', rootMessageId: 'r1' });
    useThreadInboxStore.getState().bump({ source: 'channel', contextId: 'c1', rootMessageId: 'r2' });
    useThreadInboxStore.getState().clearRoot({ source: 'channel', contextId: 'c1', rootMessageId: 'r1' });
    assert({
      given: 'two unread roots followed by a clear of one',
      should: 'leave the other root contributing to the count',
      actual: useThreadInboxStore.getState().contextUnreadCount('channel', 'c1'),
      expected: 1,
    });
  });

  it('does not mix counts between channel and DM with the same contextId string', () => {
    useThreadInboxStore.getState().bump({ source: 'channel', contextId: 'shared', rootMessageId: 'r1' });
    assert({
      given: 'a channel bump for context "shared"',
      should: 'NOT contribute to the DM-side count for "shared"',
      actual: useThreadInboxStore.getState().contextUnreadCount('dm', 'shared'),
      expected: 0,
    });
  });

  it('clearing a root that was never bumped is a no-op', () => {
    useThreadInboxStore.getState().bump({ source: 'channel', contextId: 'c1', rootMessageId: 'r1' });
    useThreadInboxStore.getState().clearRoot({ source: 'channel', contextId: 'c1', rootMessageId: 'unknown' });
    assert({
      given: 'a clear for a root that was never bumped',
      should: 'leave the existing badge count unchanged',
      actual: useThreadInboxStore.getState().contextUnreadCount('channel', 'c1'),
      expected: 1,
    });
  });

  it('multiple bumps for the same root still count as one unread root', () => {
    useThreadInboxStore.getState().bump({ source: 'channel', contextId: 'c1', rootMessageId: 'r1' });
    useThreadInboxStore.getState().bump({ source: 'channel', contextId: 'c1', rootMessageId: 'r1' });
    assert({
      given: 'two bumps for the same root',
      should: 'count the root once toward the badge',
      actual: useThreadInboxStore.getState().contextUnreadCount('channel', 'c1'),
      expected: 1,
    });
  });
});
