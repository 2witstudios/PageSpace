/**
 * Load-status transitions on ConversationCacheEntry (PR 5B, leaf 5.2).
 *
 * The entry carries `loadStatus` so surfaces can render loading/error UI from
 * the cache instead of per-surface local state (`isLoadingMessages`,
 * `globalMessagesLoadError`, `isConversationMessagesLoading`, ...) — leaf 5.2:
 * "its load-error banner reads the cache entry's error state".
 */
import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { seedEmpty } from '../seedEmpty';
import { applyStartLoad } from '../applyStartLoad';
import { applyLoad } from '../applyLoad';
import { applyFailLoad } from '../applyFailLoad';

const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [] });

describe('conversation cache loadStatus', () => {
  it('given a freshly seeded entry, loadStatus should be "idle"', () => {
    expect(seedEmpty().loadStatus).toBe('idle');
  });

  it('given applyStartLoad, loadStatus should be "loading"', () => {
    const { byConversationId } = applyStartLoad({}, 'c1');
    expect(byConversationId.c1.loadStatus).toBe('loading');
  });

  it('given applyLoad with the current generation, loadStatus should be "loaded"', () => {
    const { byConversationId, generation } = applyStartLoad({}, 'c1');
    const next = applyLoad(byConversationId, { conversationId: 'c1', generation, messages: [msg('m1')] });
    expect(next.c1.loadStatus).toBe('loaded');
    expect(next.c1.messages).toEqual([msg('m1')]);
  });

  it('given applyLoad with a stale generation, loadStatus should stay "loading" (newer load owns the entry)', () => {
    const first = applyStartLoad({}, 'c1');
    const second = applyStartLoad(first.byConversationId, 'c1');
    const next = applyLoad(second.byConversationId, {
      conversationId: 'c1',
      generation: first.generation,
      messages: [msg('stale')],
    });
    expect(next.c1.loadStatus).toBe('loading');
    expect(next.c1.messages).toEqual([]);
  });

  it('given applyFailLoad with the current generation, loadStatus should be "error" and messages preserved', () => {
    const seeded = applyStartLoad({}, 'c1');
    const loaded = applyLoad(seeded.byConversationId, { conversationId: 'c1', generation: seeded.generation, messages: [msg('m1')] });
    const reloading = applyStartLoad(loaded, 'c1');
    const next = applyFailLoad(reloading.byConversationId, { conversationId: 'c1', generation: reloading.generation });
    expect(next.c1.loadStatus).toBe('error');
    // The historical guarantee stands: a failed reload never clears cached messages.
    expect(next.c1.messages).toEqual([msg('m1')]);
  });

  it('given applyFailLoad with a stale generation, should be a full no-op (the newer load owns the status)', () => {
    const first = applyStartLoad({}, 'c1');
    const second = applyStartLoad(first.byConversationId, 'c1');
    const next = applyFailLoad(second.byConversationId, { conversationId: 'c1', generation: first.generation });
    expect(next).toBe(second.byConversationId);
  });

  it('given applyFailLoad for a conversation never started, should be a full no-op', () => {
    const byConversationId = {};
    expect(applyFailLoad(byConversationId, { conversationId: 'c1', generation: 1 })).toBe(byConversationId);
  });

  it('given a failed load followed by a new startLoad + applyLoad, loadStatus should recover to "loaded"', () => {
    const first = applyStartLoad({}, 'c1');
    const failed = applyFailLoad(first.byConversationId, { conversationId: 'c1', generation: first.generation });
    const retry = applyStartLoad(failed, 'c1');
    expect(retry.byConversationId.c1.loadStatus).toBe('loading');
    const next = applyLoad(retry.byConversationId, { conversationId: 'c1', generation: retry.generation, messages: [msg('m1')] });
    expect(next.c1.loadStatus).toBe('loaded');
  });
});
