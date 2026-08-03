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
  it('given no pending stream and a cached conversation, should return true', () => {
    expect(shouldReloadOnComountComplete(undefined, 'conv-xyz', true, false)).toBe(true);
  });

  it('given a pending stream with parts, should return false (the commit branch owns it)', () => {
    const stream = makeStream({ conversationId: 'conv-xyz' });
    expect(shouldReloadOnComountComplete(stream, 'conv-xyz', true, false)).toBe(false);
  });

  it('given a pending stream with no parts, should return true (treat as missing)', () => {
    const stream = makeStream({ parts: [] });
    expect(shouldReloadOnComountComplete(stream, 'conv-xyz', true, false)).toBe(true);
  });

  it('given the completed conversation has no cache entry, should return false (nothing renders it; its eventual loader fetches the DB truth)', () => {
    expect(shouldReloadOnComountComplete(undefined, 'conv-xyz', false, false)).toBe(false);
  });

  it('given completedConvId is undefined, should return false', () => {
    expect(shouldReloadOnComountComplete(undefined, undefined, true, false)).toBe(false);
  });

  it('given the cache already holds the final message, should return false (local onFinish commit landed first)', () => {
    expect(shouldReloadOnComountComplete(undefined, 'conv-xyz', true, true)).toBe(false);
  });

  it('given the cache holds the final message and a zero-parts stream entry, should still return false', () => {
    const stream = makeStream({ parts: [] });
    expect(shouldReloadOnComountComplete(stream, 'conv-xyz', true, true)).toBe(false);
  });
});
