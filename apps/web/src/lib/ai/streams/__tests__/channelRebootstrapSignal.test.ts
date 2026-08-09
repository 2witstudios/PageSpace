import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerChannelRebootstrap,
  unregisterChannelRebootstrap,
  notifyRemainingChannelSubscribers,
  resetChannelRebootstrapSignal,
} from '../channelRebootstrapSignal';

describe('channelRebootstrapSignal', () => {
  beforeEach(() => {
    resetChannelRebootstrapSignal();
  });

  it('given a registered callback, notifying its channel should call it', () => {
    const callback = vi.fn();
    registerChannelRebootstrap('page-a', callback);

    notifyRemainingChannelSubscribers('page-a');

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('given two registered callbacks on one channel, notifying should call both', () => {
    const first = vi.fn();
    const second = vi.fn();
    registerChannelRebootstrap('page-a', first);
    registerChannelRebootstrap('page-a', second);

    notifyRemainingChannelSubscribers('page-a');

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('given callbacks on two different channels, notifying one should not call the other\'s', () => {
    const onA = vi.fn();
    const onB = vi.fn();
    registerChannelRebootstrap('page-a', onA);
    registerChannelRebootstrap('page-b', onB);

    notifyRemainingChannelSubscribers('page-a');

    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled();
  });

  it('given an unregistered callback, notifying should not call it', () => {
    const callback = vi.fn();
    registerChannelRebootstrap('page-a', callback);
    unregisterChannelRebootstrap('page-a', callback);

    notifyRemainingChannelSubscribers('page-a');

    expect(callback).not.toHaveBeenCalled();
  });

  it('given one of two callbacks unregisters, notifying should only call the remaining one', () => {
    const leaving = vi.fn();
    const staying = vi.fn();
    registerChannelRebootstrap('page-a', leaving);
    registerChannelRebootstrap('page-a', staying);

    unregisterChannelRebootstrap('page-a', leaving);
    notifyRemainingChannelSubscribers('page-a');

    expect(leaving).not.toHaveBeenCalled();
    expect(staying).toHaveBeenCalledTimes(1);
  });

  // Coverage gap this closes: unregister is called unconditionally by every unmounting
  // useChannelStreamSocket instance, regardless of whether this exact channel/callback pair
  // was ever registered (e.g. a channelId that changed before the effect's first run
  // completed). Must be a safe no-op, not a throw.
  it('given an unregister for a channel that was never registered, should not throw', () => {
    expect(() => unregisterChannelRebootstrap('page-never', vi.fn())).not.toThrow();
  });

  // Coverage gap this closes: notifyRemainingChannelSubscribers is only reachable in
  // production when a sibling remains registered (useChannelStreamSocket gates the call on
  // wasLastSubscriber being false) — but as a standalone module function it must still
  // safely no-op when called for a channel with no registered subscribers at all, rather
  // than assuming the caller's invariant always holds.
  it('given a notify for a channel with no registered subscribers, should not throw and should call nothing', () => {
    expect(() => notifyRemainingChannelSubscribers('page-empty')).not.toThrow();
  });

  it('given a channel whose last subscriber already unregistered, a later notify should call nothing', () => {
    const callback = vi.fn();
    registerChannelRebootstrap('page-a', callback);
    unregisterChannelRebootstrap('page-a', callback);

    expect(() => notifyRemainingChannelSubscribers('page-a')).not.toThrow();
    expect(callback).not.toHaveBeenCalled();
  });
});
