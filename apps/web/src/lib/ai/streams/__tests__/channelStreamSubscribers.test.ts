import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerChannelStreamSubscriber,
  unregisterChannelStreamSubscriber,
  getChannelStreamSubscriberCount,
  resetChannelStreamSubscribers,
} from '../channelStreamSubscribers';

describe('channelStreamSubscribers', () => {
  beforeEach(() => {
    resetChannelStreamSubscribers();
  });

  it('given an unregistered channel, should report a count of 0', () => {
    expect(getChannelStreamSubscriberCount('page-a')).toBe(0);
  });

  it('given one register, should report a count of 1', () => {
    registerChannelStreamSubscriber('page-a');
    expect(getChannelStreamSubscriberCount('page-a')).toBe(1);
  });

  it('given a register then unregister, should return true (was the last) and count 0', () => {
    registerChannelStreamSubscriber('page-a');
    expect(unregisterChannelStreamSubscriber('page-a')).toBe(true);
    expect(getChannelStreamSubscriberCount('page-a')).toBe(0);
  });

  it('given two registers, unregistering the first should return false (not last), the second should return true', () => {
    registerChannelStreamSubscriber('page-a');
    registerChannelStreamSubscriber('page-a');

    expect(unregisterChannelStreamSubscriber('page-a')).toBe(false);
    expect(getChannelStreamSubscriberCount('page-a')).toBe(1);

    expect(unregisterChannelStreamSubscriber('page-a')).toBe(true);
    expect(getChannelStreamSubscriberCount('page-a')).toBe(0);
  });

  it('given registers on two different channels, should not leak into each other', () => {
    registerChannelStreamSubscriber('page-a');
    registerChannelStreamSubscriber('page-b');
    registerChannelStreamSubscriber('page-b');

    expect(getChannelStreamSubscriberCount('page-a')).toBe(1);
    expect(getChannelStreamSubscriberCount('page-b')).toBe(2);

    unregisterChannelStreamSubscriber('page-a');
    expect(getChannelStreamSubscriberCount('page-a')).toBe(0);
    expect(getChannelStreamSubscriberCount('page-b')).toBe(2);
  });

  // Coverage gap this closes: unregister is only ever called by useChannelStreamSocket's
  // own cleanup, always paired with an earlier register in the same effect instance — but
  // the function itself has no way to enforce that. Called on a channel that was never
  // registered (or already fully unregistered), it must not throw and should report "was
  // the last" (true) rather than silently going negative — erring toward the caller's
  // clearPageStreams path running rather than a phantom subscriber being assumed to remain.
  it('given an unregister for a channel that was never registered, should not throw and should report true (nothing left)', () => {
    expect(() => unregisterChannelStreamSubscriber('page-never')).not.toThrow();
    expect(unregisterChannelStreamSubscriber('page-never')).toBe(true);
    expect(getChannelStreamSubscriberCount('page-never')).toBe(0);
  });
});
