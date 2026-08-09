import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFetchWithAuth, mockRefreshSnapshot, revs } = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
  mockRefreshSnapshot: vi.fn().mockResolvedValue(undefined),
  revs: { current: new Map<string, number | null>() },
}));

vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: mockFetchWithAuth }));
vi.mock('@/hooks/conversationMessagesLoaders', () => ({
  refreshConversationSnapshot: mockRefreshSnapshot,
}));
vi.mock('@/hooks/conversationMessagesActions', () => ({
  conversationMessagesActions: {
    getRev: (id: string) => revs.current.get(id) ?? null,
  },
}));

import {
  healConversationToRev,
  registerConversationWatch,
  resetConversationWatches,
  syncWatchedConversationRevs,
  unregisterConversationWatch,
  watchedConversationIds,
} from '../conversation-rev-sync';

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('conversation-rev-sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetConversationWatches();
    revs.current = new Map();
    mockRefreshSnapshot.mockResolvedValue(undefined);
  });

  describe('the watch registry', () => {
    it('given one registration, should include the conversation in the batch', () => {
      registerConversationWatch('c1', 'page-1');

      expect(watchedConversationIds()).toEqual(['c1']);
    });

    // Two panes on one conversation: the first unmount must not blind the second.
    it('given two watchers, should keep the conversation until BOTH unregister', () => {
      registerConversationWatch('c1', 'page-1');
      registerConversationWatch('c1', 'page-1');

      unregisterConversationWatch('c1');
      expect(watchedConversationIds()).toEqual(['c1']);

      unregisterConversationWatch('c1');
      expect(watchedConversationIds()).toEqual([]);
    });

    it('given an unregister for an unknown conversation, should be a no-op', () => {
      unregisterConversationWatch('never-registered');

      expect(watchedConversationIds()).toEqual([]);
    });
  });

  describe('syncWatchedConversationRevs', () => {
    it('given no watchers, should not make a request at all', async () => {
      await syncWatchedConversationRevs();

      expect(mockFetchWithAuth).not.toHaveBeenCalled();
    });

    it('given several watched conversations, should ask about all of them in ONE request', async () => {
      registerConversationWatch('c1', 'page-1');
      registerConversationWatch('c2', null);
      revs.current.set('c1', 5);
      revs.current.set('c2', 2);
      mockFetchWithAuth.mockResolvedValue(okJson({ revs: { c1: 5, c2: 2 } }));

      await syncWatchedConversationRevs();

      expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetchWithAuth.mock.calls[0];
      expect(url).toBe('/api/ai/conversations/revs');
      expect(JSON.parse((init as { body: string }).body)).toEqual({ ids: ['c1', 'c2'] });
    });

    it('given every watermark already matches, should refetch nothing', async () => {
      registerConversationWatch('c1', 'page-1');
      revs.current.set('c1', 5);
      mockFetchWithAuth.mockResolvedValue(okJson({ revs: { c1: 5 } }));

      await syncWatchedConversationRevs();

      expect(mockRefreshSnapshot).not.toHaveBeenCalled();
    });

    it('given the server is AHEAD of a watermark, should refetch exactly that conversation', async () => {
      registerConversationWatch('c1', 'page-1');
      registerConversationWatch('c2', null);
      revs.current.set('c1', 5);
      revs.current.set('c2', 9);
      mockFetchWithAuth.mockResolvedValue(okJson({ revs: { c1: 8, c2: 9 } }));
      // The heal's post-check sees the refreshed watermark.
      mockRefreshSnapshot.mockImplementation(async (_agentId: string | null, id: string) => {
        revs.current.set(id, 8);
      });

      await syncWatchedConversationRevs();

      expect(mockRefreshSnapshot).toHaveBeenCalledTimes(1);
      expect(mockRefreshSnapshot).toHaveBeenCalledWith('page-1', 'c1');
    });

    it('given a conversation with NO local watermark, should refetch it — "unknown" is not "current"', async () => {
      registerConversationWatch('c1', 'page-1');
      mockFetchWithAuth.mockResolvedValue(okJson({ revs: { c1: 3 } }));
      mockRefreshSnapshot.mockImplementation(async (_agentId: string | null, id: string) => {
        revs.current.set(id, 3);
      });

      await syncWatchedConversationRevs();

      expect(mockRefreshSnapshot).toHaveBeenCalledWith('page-1', 'c1');
    });

    // The route filters through canAccessConversation, so an un-shared or deleted
    // conversation simply isn't in the answer. Blanking a cache the user can still
    // see would be worse than leaving it.
    it('given an id absent from the response, should leave that conversation alone', async () => {
      registerConversationWatch('c1', 'page-1');
      mockFetchWithAuth.mockResolvedValue(okJson({ revs: {} }));

      await syncWatchedConversationRevs();

      expect(mockRefreshSnapshot).not.toHaveBeenCalled();
    });

    it('given a failed request, should swallow it — the next event\'s gap detection is a second chance', async () => {
      registerConversationWatch('c1', 'page-1');
      mockFetchWithAuth.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

      await expect(syncWatchedConversationRevs()).resolves.toBeUndefined();
      expect(mockRefreshSnapshot).not.toHaveBeenCalled();
    });

    it('given a thrown request, should swallow it too', async () => {
      registerConversationWatch('c1', 'page-1');
      mockFetchWithAuth.mockRejectedValue(new Error('offline'));

      await expect(syncWatchedConversationRevs()).resolves.toBeUndefined();
    });

    // Every mounted subscription observes the same reconnect. N identical batch
    // requests would be N times the work for one answer.
    it('given concurrent callers, should issue ONE request and hand them all the same promise', async () => {
      registerConversationWatch('c1', 'page-1');
      revs.current.set('c1', 1);
      mockFetchWithAuth.mockResolvedValue(okJson({ revs: { c1: 1 } }));

      await Promise.all([
        syncWatchedConversationRevs(),
        syncWatchedConversationRevs(),
        syncWatchedConversationRevs(),
      ]);

      expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
    });

    it('given a sync AFTER an earlier one settled, should fetch fresh rather than reuse the old answer', async () => {
      registerConversationWatch('c1', 'page-1');
      revs.current.set('c1', 1);
      mockFetchWithAuth.mockResolvedValue(okJson({ revs: { c1: 1 } }));

      await syncWatchedConversationRevs();
      await syncWatchedConversationRevs();

      expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);
    });
  });

  describe('healConversationToRev', () => {
    it('given the first snapshot reaches the target, should stop at one refetch', async () => {
      mockRefreshSnapshot.mockImplementation(async (_agentId: string | null, id: string) => {
        revs.current.set(id, 9);
      });

      await healConversationToRev('c1', 'page-1', 9);

      expect(mockRefreshSnapshot).toHaveBeenCalledTimes(1);
    });

    // refreshConversationSnapshot coalesces concurrent refreshes, so a heal can ride
    // a fetch issued BEFORE the write it is meant to heal to. One extra pass — after
    // the first settled, so the coalescing map is clear — closes that.
    it('given the first snapshot still falls short (a coalesced, older fetch), should make exactly one more pass', async () => {
      let call = 0;
      mockRefreshSnapshot.mockImplementation(async (_agentId: string | null, id: string) => {
        call += 1;
        revs.current.set(id, call === 1 ? 7 : 9);
      });

      await healConversationToRev('c1', 'page-1', 9);

      expect(mockRefreshSnapshot).toHaveBeenCalledTimes(2);
    });

    it('given an unreachable target, should still stop after two passes — never a retry storm', async () => {
      mockRefreshSnapshot.mockImplementation(async (_agentId: string | null, id: string) => {
        revs.current.set(id, 1);
      });

      await healConversationToRev('c1', 'page-1', 1000);

      expect(mockRefreshSnapshot).toHaveBeenCalledTimes(2);
    });

    it('given no target rev, should refetch once and ask no questions', async () => {
      await healConversationToRev('c1', null, null);

      expect(mockRefreshSnapshot).toHaveBeenCalledTimes(1);
      expect(mockRefreshSnapshot).toHaveBeenCalledWith(null, 'c1');
    });
  });
});
