import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  markChannelConsuming,
  unmarkChannelConsuming,
  isChannelConsuming,
  resetConsumingChannels,
} from '../consumingChannels';

describe('consumingChannels', () => {
  beforeEach(() => {
    resetConsumingChannels();
  });

  it('given an unmarked channel, should report not consuming', () => {
    expect(isChannelConsuming('page-a')).toBe(false);
  });

  it('given a marked channel, should report consuming', () => {
    markChannelConsuming('page-a');
    expect(isChannelConsuming('page-a')).toBe(true);
  });

  it('given a marked channel, should not leak into other channels', () => {
    markChannelConsuming('page-a');
    expect(isChannelConsuming('page-b')).toBe(false);
  });

  it('given a channel marked then unmarked, should report not consuming', () => {
    markChannelConsuming('page-a');
    unmarkChannelConsuming('page-a');
    expect(isChannelConsuming('page-a')).toBe(false);
  });

  // REFCOUNTED. GlobalAssistantView (agent mode) and SidebarChatTab (agent mode)
  // co-mount on the SAME channel (selectedAgent.id) with independent useChat instances,
  // and both can be streaming. With plain Set semantics the first body to finish would
  // clear the flag for the other — which is still reading its own body — and the next
  // reconnect bootstrap would attach it to a stream it is already rendering.
  it('given two consumers on one channel and only one finishes, should STILL report consuming', () => {
    markChannelConsuming('page-a');
    markChannelConsuming('page-a');

    unmarkChannelConsuming('page-a');

    expect(isChannelConsuming('page-a')).toBe(true);
  });

  it('given two consumers on one channel and both finish, should report not consuming', () => {
    markChannelConsuming('page-a');
    markChannelConsuming('page-a');

    unmarkChannelConsuming('page-a');
    unmarkChannelConsuming('page-a');

    expect(isChannelConsuming('page-a')).toBe(false);
  });

  it('given more unmarks than marks, should not go negative (a stale release must not make a later mark a no-op)', () => {
    markChannelConsuming('page-a');
    unmarkChannelConsuming('page-a');
    unmarkChannelConsuming('page-a');
    unmarkChannelConsuming('page-a');

    expect(isChannelConsuming('page-a')).toBe(false);

    markChannelConsuming('page-a');
    expect(isChannelConsuming('page-a')).toBe(true);
    unmarkChannelConsuming('page-a');
    expect(isChannelConsuming('page-a')).toBe(false);
  });

  it('given an unmark for a channel that was never marked, should be a no-op', () => {
    expect(() => unmarkChannelConsuming('page-never')).not.toThrow();
    expect(isChannelConsuming('page-never')).toBe(false);
  });

  // THE property this module exists for. A fresh document evaluates this module from
  // scratch, so the set is empty — which is exactly what makes a reloaded tab stop
  // classifying itself as "the originator" and re-attach to its own live stream.
  // (sessionStorage-backed browserSessionId, the thing this replaced, survives reload.)
  it('given a fresh module evaluation (i.e. a page reload), should report nothing as consuming', async () => {
    markChannelConsuming('page-a');
    expect(isChannelConsuming('page-a')).toBe(true);

    // A reload re-evaluates the module graph from scratch. resetModules is the closest
    // faithful analogue: the next import gets a brand-new Set.
    vi.resetModules();
    const reloaded = await import('../consumingChannels');

    expect(reloaded.isChannelConsuming('page-a')).toBe(false);
  });
});
