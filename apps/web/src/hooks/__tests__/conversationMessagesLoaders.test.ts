/**
 * Shared cache load path (PR 5B) — the ONE way a conversation's DB messages
 * reach `useConversationMessagesStore`, for every surface and store.
 *
 * includeStreaming=1 is carried UNIFORMLY (absorbed E2 D task
 * co2as25wcpme4m4gxqu4zgcj): GlobalChatContext.loadConversation had it but the
 * agent-mode loaders did not, so SidebarHistoryTab's streaming badge lit and
 * click-through showed a stale placeholder for agent conversations. The
 * placeholder row's id collides with the live pending-stream entry, and
 * `selectRenderedMessages` renders the live stream in place of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import {
  loadGlobalConversationMessages,
  loadAgentConversationMessages,
  loadOlderGlobalConversationMessages,
  loadOlderAgentConversationMessages,
} from '../conversationMessagesLoaders';

const mockedFetch = vi.mocked(fetchWithAuth);

const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [] });

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as Response;
const errorResponse = (status: number) =>
  ({ ok: false, status, json: async () => ({}) }) as Response;

describe('conversationMessagesLoaders', () => {
  beforeEach(() => {
    useConversationMessagesStore.setState({ byConversationId: {} });
    mockedFetch.mockReset();
  });

  it('given a global load, should request includeStreaming=1 so a history rejoin sees the in-flight placeholder', async () => {
    mockedFetch.mockResolvedValue(okResponse({ messages: [msg('m1')] }));
    await loadGlobalConversationMessages('c1');
    const url = mockedFetch.mock.calls[0][0] as string;
    expect(url).toContain('/api/ai/global/c1/messages');
    expect(url).toContain('includeStreaming=1');
  });

  it('given an agent load, should request includeStreaming=1 (the gap the E2 D task names)', async () => {
    mockedFetch.mockResolvedValue(okResponse({ messages: [msg('m1')] }));
    await loadAgentConversationMessages('agent-1', 'c1');
    const url = mockedFetch.mock.calls[0][0] as string;
    expect(url).toContain('/api/ai/page-agents/agent-1/conversations/c1/messages');
    expect(url).toContain('includeStreaming=1');
  });

  it('given a successful global load, should commit messages and mark the entry loaded', async () => {
    mockedFetch.mockResolvedValue(okResponse({ messages: [msg('m1'), msg('m2')] }));
    await loadGlobalConversationMessages('c1');
    const entry = useConversationMessagesStore.getState().getEntry('c1');
    expect(entry.messages).toEqual([msg('m1'), msg('m2')]);
    expect(entry.loadStatus).toBe('loaded');
  });

  it('given a bare-array global response (legacy shape), should still commit', async () => {
    mockedFetch.mockResolvedValue(okResponse([msg('m1')]));
    await loadGlobalConversationMessages('c1');
    expect(useConversationMessagesStore.getState().getEntry('c1').messages).toEqual([msg('m1')]);
  });

  it('given an ok response with no messages field at all, should commit an empty list rather than throw', async () => {
    mockedFetch.mockResolvedValue(okResponse({}));
    await loadGlobalConversationMessages('c1');
    const entry = useConversationMessagesStore.getState().getEntry('c1');
    expect(entry.messages).toEqual([]);
    expect(entry.loadStatus).toBe('loaded');
  });

  it('given a successful agent load, should commit messages and mark the entry loaded', async () => {
    mockedFetch.mockResolvedValue(okResponse({ messages: [msg('a1')] }));
    await loadAgentConversationMessages('agent-1', 'c1');
    const entry = useConversationMessagesStore.getState().getEntry('c1');
    expect(entry.messages).toEqual([msg('a1')]);
    expect(entry.loadStatus).toBe('loaded');
  });

  it('given a non-ok global response, should mark the entry errored and keep prior messages', async () => {
    mockedFetch.mockResolvedValue(okResponse({ messages: [msg('m1')] }));
    await loadGlobalConversationMessages('c1');
    mockedFetch.mockResolvedValue(errorResponse(500));
    await loadGlobalConversationMessages('c1');
    const entry = useConversationMessagesStore.getState().getEntry('c1');
    expect(entry.loadStatus).toBe('error');
    expect(entry.messages).toEqual([msg('m1')]);
  });

  it('given a rejected agent fetch, should mark the entry errored and keep prior messages', async () => {
    mockedFetch.mockResolvedValue(okResponse({ messages: [msg('a1')] }));
    await loadAgentConversationMessages('agent-1', 'c1');
    mockedFetch.mockRejectedValue(new Error('network'));
    await loadAgentConversationMessages('agent-1', 'c1');
    const entry = useConversationMessagesStore.getState().getEntry('c1');
    expect(entry.loadStatus).toBe('error');
    expect(entry.messages).toEqual([msg('a1')]);
  });

  it('given a slow load superseded by a newer one for the same conversation, the stale result should be dropped', async () => {
    let resolveFirst!: (r: Response) => void;
    mockedFetch
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(async () => okResponse({ messages: [msg('fresh')] }));

    const first = loadGlobalConversationMessages('c1');
    const second = loadGlobalConversationMessages('c1');
    await second;
    resolveFirst(okResponse({ messages: [msg('stale')] }));
    await first;

    const entry = useConversationMessagesStore.getState().getEntry('c1');
    expect(entry.messages).toEqual([msg('fresh')]);
    expect(entry.loadStatus).toBe('loaded');
  });

  it('given a load superseded between the response arriving and its body resolving, the stale body should be dropped', async () => {
    let resolveBody!: (v: unknown) => void;
    mockedFetch
      .mockImplementationOnce(async () =>
        ({ ok: true, status: 200, json: () => new Promise((resolve) => { resolveBody = resolve; }) }) as Response)
      .mockImplementationOnce(async () => okResponse({ messages: [msg('fresh')] }));

    const first = loadGlobalConversationMessages('c1');
    // The response headers have landed for the first load; before its BODY resolves,
    // a newer load starts and completes.
    await new Promise((r) => setTimeout(r, 0));
    await loadGlobalConversationMessages('c1');
    resolveBody({ messages: [msg('stale')] });
    await first;

    expect(useConversationMessagesStore.getState().getEntry('c1').messages).toEqual([msg('fresh')]);
  });

  it('given a slow AGENT load superseded by a newer one, the stale result should be dropped', async () => {
    let resolveFirst!: (r: Response) => void;
    mockedFetch
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(async () => okResponse({ messages: [msg('fresh')] }));

    const first = loadAgentConversationMessages('agent-1', 'c1');
    const second = loadAgentConversationMessages('agent-1', 'c1');
    await second;
    resolveFirst(okResponse({ messages: [msg('stale')] }));
    await first;

    const entry = useConversationMessagesStore.getState().getEntry('c1');
    expect(entry.messages).toEqual([msg('fresh')]);
    expect(entry.loadStatus).toBe('loaded');
  });

  it('given a stale load failing after a newer one succeeded, the error must not clobber the loaded status', async () => {
    let rejectFirst!: (e: Error) => void;
    mockedFetch
      .mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { rejectFirst = reject; }))
      .mockImplementationOnce(async () => okResponse({ messages: [msg('fresh')] }));

    const first = loadGlobalConversationMessages('c1');
    const second = loadGlobalConversationMessages('c1');
    await second;
    rejectFirst(new Error('network'));
    await first;

    expect(useConversationMessagesStore.getState().getEntry('c1').loadStatus).toBe('loaded');
  });

  // Epic leaf 6.6: the pagination envelope was silently dropped before this PR.
  describe('pagination envelope capture', () => {
    it('given an initial global load with a pagination envelope, should capture hasMoreOlder/olderCursor', async () => {
      mockedFetch.mockResolvedValue(
        okResponse({ messages: [msg('m1')], pagination: { hasMore: true, nextCursor: 'm1', prevCursor: null, limit: 50, direction: 'before' } }),
      );
      await loadGlobalConversationMessages('c1');
      const entry = useConversationMessagesStore.getState().getEntry('c1');
      expect(entry.hasMoreOlder).toBe(true);
      expect(entry.olderCursor).toBe('m1');
    });

    it('given a bare-array (legacy) global response, should default hasMoreOlder=false rather than throw', async () => {
      mockedFetch.mockResolvedValue(okResponse([msg('m1')]));
      await loadGlobalConversationMessages('c1');
      expect(useConversationMessagesStore.getState().getEntry('c1').hasMoreOlder).toBe(false);
    });
  });

  describe('loadOlderGlobalConversationMessages', () => {
    const seedLoaded = async (hasMore: boolean, cursor: string | null) => {
      mockedFetch.mockResolvedValue(
        okResponse({ messages: [msg('m1')], pagination: { hasMore, nextCursor: cursor, prevCursor: null, limit: 50, direction: 'before' } }),
      );
      await loadGlobalConversationMessages('c1');
    };

    it('given hasMoreOlder=false, should never fetch', async () => {
      await seedLoaded(false, null);
      mockedFetch.mockClear();
      await loadOlderGlobalConversationMessages('c1');
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('given isLoadingOlder already true, should not fetch again (double-trigger guard)', async () => {
      await seedLoaded(true, 'm1');
      useConversationMessagesStore.getState().startLoadingOlder('c1');
      mockedFetch.mockClear();
      await loadOlderGlobalConversationMessages('c1');
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('given hasMoreOlder=true, should fetch with the cursor and prepend the older page', async () => {
      await seedLoaded(true, 'm1');
      mockedFetch.mockResolvedValue(
        okResponse({ messages: [msg('older1')], pagination: { hasMore: false, nextCursor: null, prevCursor: null, limit: 50, direction: 'before' } }),
      );
      await loadOlderGlobalConversationMessages('c1');

      const url = mockedFetch.mock.calls[mockedFetch.mock.calls.length - 1][0] as string;
      expect(url).toContain('cursor=m1');
      expect(url).toContain('direction=before');

      const entry = useConversationMessagesStore.getState().getEntry('c1');
      expect(entry.messages).toEqual([msg('older1'), msg('m1')]);
      expect(entry.hasMoreOlder).toBe(false);
      expect(entry.olderCursor).toBeNull();
      expect(entry.isLoadingOlder).toBe(false);
    });

    it('given the older-page fetch fails, should clear isLoadingOlder and leave messages intact', async () => {
      await seedLoaded(true, 'm1');
      mockedFetch.mockResolvedValue(errorResponse(500));
      await loadOlderGlobalConversationMessages('c1');

      const entry = useConversationMessagesStore.getState().getEntry('c1');
      expect(entry.isLoadingOlder).toBe(false);
      expect(entry.messages).toEqual([msg('m1')]);
      // loadStatus untouched — this is an inline indicator failure, not a full-load error.
      expect(entry.loadStatus).toBe('loaded');
    });
  });

  describe('loadOlderAgentConversationMessages', () => {
    it('given hasMoreOlder=true, should fetch with the cursor and prepend the older page', async () => {
      mockedFetch.mockResolvedValue(
        okResponse({ messages: [msg('a1')], pagination: { hasMore: true, nextCursor: 'a1', prevCursor: null, limit: 50, direction: 'before' } }),
      );
      await loadAgentConversationMessages('agent-1', 'c1');

      mockedFetch.mockResolvedValue(
        okResponse({ messages: [msg('older-a')], pagination: { hasMore: false, nextCursor: null, prevCursor: null, limit: 50, direction: 'before' } }),
      );
      await loadOlderAgentConversationMessages('agent-1', 'c1');

      const url = mockedFetch.mock.calls[mockedFetch.mock.calls.length - 1][0] as string;
      expect(url).toContain('cursor=a1');
      expect(url).toContain('direction=before');

      const entry = useConversationMessagesStore.getState().getEntry('c1');
      expect(entry.messages).toEqual([msg('older-a'), msg('a1')]);
    });
  });
});
