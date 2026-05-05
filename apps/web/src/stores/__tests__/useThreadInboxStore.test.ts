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

  it('bump with empty rootMessageId is a no-op (defensive guard against malformed inbox events)', () => {
    useThreadInboxStore.getState().bump({ source: 'channel', contextId: 'page-1', rootMessageId: '' });
    assert({
      given: 'a bump with rootMessageId === ""',
      should: 'leave the store untouched (no phantom empty-key root)',
      actual: useThreadInboxStore.getState().contexts,
      expected: {},
    });
  });

  it('bump with null/undefined rootMessageId is a no-op at runtime', () => {
    // The TS signature forbids null/undefined; assert runtime defensiveness so
    // a malformed payload from the inbox socket can't poison the store.
    useThreadInboxStore
      .getState()
      // @ts-expect-error — runtime defensiveness for malformed event payloads
      .bump({ source: 'channel', contextId: 'page-1', rootMessageId: null });
    useThreadInboxStore
      .getState()
      // @ts-expect-error — runtime defensiveness for malformed event payloads
      .bump({ source: 'channel', contextId: 'page-1', rootMessageId: undefined });

    assert({
      given: 'bumps with rootMessageId === null and undefined',
      should: 'leave the store empty (no String(null)/String(undefined) keys)',
      actual: useThreadInboxStore.getState().contexts,
      expected: {},
    });
  });

  it('alternating bump/clearRoot for the same root converges deterministically and never goes negative', () => {
    const args = { source: 'channel' as const, contextId: 'page-1', rootMessageId: 'root-1' };
    const reads: number[] = [];
    const readCount = () =>
      useThreadInboxStore.getState().contexts['channel:page-1']?.byRoot[args.rootMessageId] ?? 0;

    useThreadInboxStore.getState().bump(args);
    useThreadInboxStore.getState().bump(args);
    useThreadInboxStore.getState().bump(args);
    reads.push(readCount());
    useThreadInboxStore.getState().clearRoot(args);
    reads.push(readCount());
    useThreadInboxStore.getState().bump(args);
    reads.push(readCount());
    useThreadInboxStore.getState().clearRoot(args);
    reads.push(readCount());
    useThreadInboxStore.getState().bump(args);
    reads.push(readCount());
    useThreadInboxStore.getState().clearRoot(args);
    reads.push(readCount());

    assert({
      given: 'alternating bump/clearRoot for the same root',
      should: 'follow last-write-wins; counts never go negative or NaN at any step',
      actual: {
        intermediate: reads,
        finalCount: useThreadInboxStore.getState().contextUnreadCount('channel', 'page-1'),
        anyNegative: reads.some((n) => n < 0),
        anyNaN: reads.some((n) => Number.isNaN(n)),
      },
      expected: {
        intermediate: [3, 0, 1, 0, 1, 0],
        finalCount: 0,
        anyNegative: false,
        anyNaN: false,
      },
    });
  });

  it('clearRoot for a non-existent root in an empty store is a no-op (does not throw)', () => {
    // No prior bumps — store starts empty. clearRoot must not throw and must
    // leave state observably unchanged.
    useThreadInboxStore
      .getState()
      .clearRoot({ source: 'channel', contextId: 'page-1', rootMessageId: 'root-1' });

    assert({
      given: 'a clearRoot call against an empty store',
      should: 'be a silent no-op with no contexts created',
      actual: useThreadInboxStore.getState().contexts,
      expected: {},
    });
  });
});
