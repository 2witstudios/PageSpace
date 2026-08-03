import { describe, it, expect } from 'vitest';
import { shouldReloadOnComountComplete } from '../shouldReloadOnComountComplete';
import type { PendingStream } from '@/stores/usePendingStreamsStore';

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
  it('given no pending stream and matching conversationId, should return true', () => {
    expect(shouldReloadOnComountComplete(undefined, 'conv-xyz', 'conv-xyz', false)).toBe(true);
  });

  it('given a pending stream with parts and matching conversationId, should return false', () => {
    const stream = makeStream({ conversationId: 'conv-xyz' });
    expect(shouldReloadOnComountComplete(stream, 'conv-xyz', 'conv-xyz', false)).toBe(false);
  });

  it('given a pending stream with no parts, should return true (treat as missing)', () => {
    const stream = makeStream({ parts: [] });
    expect(shouldReloadOnComountComplete(stream, 'conv-xyz', 'conv-xyz', false)).toBe(true);
  });

  it('given completedConvId does not match active conversation, should return false', () => {
    expect(shouldReloadOnComountComplete(undefined, 'conv-other', 'conv-xyz', false)).toBe(false);
  });

  it('given completedConvId is undefined, should return false', () => {
    expect(shouldReloadOnComountComplete(undefined, undefined, 'conv-xyz', false)).toBe(false);
  });

  it('given activeConversationId is null, should return false', () => {
    expect(shouldReloadOnComountComplete(undefined, 'conv-xyz', null, false)).toBe(false);
  });

  it('given the cache already holds the final message, should return false (local onFinish commit landed first)', () => {
    expect(shouldReloadOnComountComplete(undefined, 'conv-xyz', 'conv-xyz', true)).toBe(false);
  });

  it('given the cache holds the final message and a zero-parts stream entry, should still return false', () => {
    const stream = makeStream({ parts: [] });
    expect(shouldReloadOnComountComplete(stream, 'conv-xyz', 'conv-xyz', true)).toBe(false);
  });
});
