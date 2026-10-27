import { describe, it, expect } from 'vitest';
import { shouldReloadOnComountComplete } from '../shouldReloadOnComountComplete';
import type { PendingStream } from '@/stores/usePendingStreamsStore';

// Cached-conversation and completedConvId-presence gating live in the caller
// (conversationCacheSocketHandlers) and are covered by the handler-level tests
// in useAgentChannelMultiplayer.test.ts — this decides only whether a reload
// adds anything for a cached conversation's completion.

const makeStream = (overrides: Partial<PendingStream> = {}): PendingStream => ({
  messageId: 'msg-1',
  pageId: 'page-1',
  conversationId: 'conv-xyz',
  triggeredBy: { userId: 'u1', displayName: 'Alice' },
  parts: [{ type: 'text', text: 'hello' }],
  isOwn: false,
  ...overrides,
});

describe('shouldReloadOnComountComplete', () => {
  it('given no pending stream and no consistent cached row, should return true', () => {
    expect(shouldReloadOnComountComplete(undefined, false)).toBe(true);
  });

  it('given a pending stream with parts, should return false (the commit branch owns it)', () => {
    expect(shouldReloadOnComountComplete(makeStream(), false)).toBe(false);
  });

  it('given a pending stream with no parts, should return true (treat as missing)', () => {
    expect(shouldReloadOnComountComplete(makeStream({ parts: [] }), false)).toBe(true);
  });

  it('given the cache already holds a consistent final message, should return false (local onFinish commit landed first)', () => {
    expect(shouldReloadOnComountComplete(undefined, true)).toBe(false);
  });

  it('given a consistent final message and a zero-parts stream entry, should still return false', () => {
    expect(shouldReloadOnComountComplete(makeStream({ parts: [] }), true)).toBe(false);
  });
});
