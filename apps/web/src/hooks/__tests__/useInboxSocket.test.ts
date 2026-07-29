/**
 * useInboxSocket regression coverage.
 *
 * Root cause (commit b922d5643, #1230): the hook used to reconstruct its own
 * SWR cache key (`driveId ? ... : '/api/inbox?limit=20'`), while every
 * consumer subscribes to SWR under a `type=`-qualified key. SWR keys by exact
 * string value, so `mutate(cacheKey, ...)` was writing into a cache entry
 * with zero subscribers — every socket-driven unread update was silently
 * discarded until the page was reloaded.
 *
 * The fix has the hook take the consumer's literal cache key instead of
 * rebuilding it. The most valuable regression test is therefore proving that
 * each consumer passes `useInboxSocket` the identical expression it passes to
 * `useSWR` — checked here directly against each consumer's source, so any
 * future PR that changes one call site without the other fails CI instead of
 * silently killing live updates again. Hook *behavior* against those same
 * literal keys (scope filtering, stale-replay, the mutate() call itself) is
 * covered separately below with the real hook and a fake socket — full DOM
 * rendering of the sidebar/list components was deliberately avoided: it pulls
 * in Radix ScrollArea, which loops on ref-callback resize measurement under
 * jsdom (no real layout signal to settle on) for reasons unrelated to this fix.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createMockSocket } from '@/test/socket-mocks';
import { useEditingStore } from '@/stores/useEditingStore';

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceCache = new Map<string, string>();
const readSource = (relPath: string) => {
  const cached = sourceCache.get(relPath);
  if (cached !== undefined) return cached;
  const content = readFileSync(resolve(srcRoot, relPath), 'utf8');
  sourceCache.set(relPath, content);
  return content;
};

// ---------------------------------------------------------------------------
// Hoisted mocks shared across all tests. `mockSocket` is built from the real
// (unmocked) `createMockSocket`, so it must stay out of vi.hoisted — that
// callback runs before other imports are initialized.
// ---------------------------------------------------------------------------
const { mockMutate } = vi.hoisted(() => ({ mockMutate: vi.fn() }));
const mockSocket = createMockSocket();

vi.mock('../useSocket', () => ({
  useSocket: () => mockSocket,
}));

vi.mock('swr', () => ({
  useSWRConfig: () => ({ mutate: mockMutate }),
}));

import { useInboxSocket } from '../useInboxSocket';
import type { InboxEventPayload } from '@/lib/websocket/socket-utils';

const CHANNEL_KEY = '/api/inbox?type=channel&limit=20';
const DM_KEY = '/api/inbox?type=dm&limit=20';

const renderInboxSocket = (overrides: Partial<Parameters<typeof useInboxSocket>[0]> = {}) =>
  renderHook(() => useInboxSocket({
    cacheKey: CHANNEL_KEY,
    scope: 'channel',
    hasLoadedRef: { current: true },
    ...overrides,
  }));

const channelPayload = (overrides: Partial<InboxEventPayload> = {}): InboxEventPayload => ({
  operation: 'channel_updated',
  type: 'channel',
  id: 'ch-1',
  lastMessageAt: '2026-07-28T12:00:00.000Z',
  unreadCount: 3,
  ...overrides,
});

const dmPayload = (overrides: Partial<InboxEventPayload> = {}): InboxEventPayload => ({
  operation: 'dm_updated',
  type: 'dm',
  id: 'dm-1',
  lastMessageAt: '2026-07-28T12:00:00.000Z',
  unreadCount: 2,
  ...overrides,
});

describe('useInboxSocket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditingStore.setState({ activeSessions: new Map(), pendingSends: new Set() });
  });

  afterEach(() => {
    useEditingStore.setState({ activeSessions: new Map(), pendingSends: new Set() });
  });

  // -------------------------------------------------------------------------
  // AC1/AC4/AC6: cache key parity between each consumer's useSWR call and the
  // cacheKey it hands to useInboxSocket, checked directly against each
  // consumer's current source. This is the assertion that catches the
  // b922d5643 regression class: any divergence between the two means
  // mutate() writes into a cache entry with no subscriber. It also fails if
  // `driveId` is reintroduced as a useInboxSocket prop (the old, reconstructed
  // key), since a passing pair requires cacheKey without it.
  // -------------------------------------------------------------------------
  describe('consumer cache-key parity', () => {
    const CONSUMERS = [
      { file: 'components/layout/left-sidebar/ChannelsSidebar.tsx', scope: 'channel' },
      { file: 'components/layout/left-sidebar/DMSidebar.tsx', scope: 'dm' },
      { file: 'components/inbox/ChannelsCenterList.tsx', scope: 'channel' },
      { file: 'components/inbox/DMCenterList.tsx', scope: 'dm' },
    ] as const;

    it.each(CONSUMERS)('$file passes useInboxSocket the exact key it passes to useSWR', ({ file, scope }) => {
      const source = readSource(file);

      const swrMatch = source.match(/useSWR<InboxResponse>\(\s*([\w$]+)\s*,\s*fetcher/);
      expect(swrMatch, `${file}: could not find a useSWR<InboxResponse>(key, fetcher, ...) call`).toBeTruthy();
      const swrKey = swrMatch![1];

      const socketCallMatch = source.match(/useInboxSocket\(\{([^}]*)\}\)/);
      expect(socketCallMatch, `${file}: could not find a useInboxSocket({ ... }) call`).toBeTruthy();
      const socketCallArgs = socketCallMatch![1];

      // The old, reconstructed-key shape passed driveId instead of cacheKey —
      // asserting its absence is what would fail if getCacheKey were restored.
      expect(socketCallArgs).not.toMatch(/driveId/);

      const cacheKeyMatch = socketCallArgs.match(/cacheKey:\s*([\w$]+)/);
      expect(cacheKeyMatch, `${file}: useInboxSocket call has no cacheKey`).toBeTruthy();
      expect(cacheKeyMatch![1]).toBe(swrKey);

      expect(socketCallArgs).toMatch(new RegExp(`scope:\\s*'${scope}'`));
    });

    it('the four consumers each enable revalidateOnFocus (self-healing on missed events)', () => {
      const files = CONSUMERS.map((c) => c.file);
      for (const file of files) {
        const source = readSource(file);
        expect(source, `${file}: revalidateOnFocus should be true`).toMatch(/revalidateOnFocus:\s*true/);
      }
    });
  });

  it('the hook never re-derives an /api/inbox URL itself', () => {
    const source = readSource('hooks/useInboxSocket.ts');
    expect(source).not.toMatch(/\/api\/inbox/);
  });

  // -------------------------------------------------------------------------
  // AC2: scope filtering
  // -------------------------------------------------------------------------
  describe('scope filtering', () => {
    it('given scope "channel", a dm-typed payload causes zero cache writes', () => {
      renderInboxSocket();

      act(() => {
        mockSocket._trigger('inbox:dm_updated', dmPayload());
      });

      expect(mockMutate).not.toHaveBeenCalled();
    });

    it('given scope "dm", a channel-typed payload causes zero cache writes', () => {
      renderInboxSocket({ cacheKey: DM_KEY, scope: 'dm' });

      act(() => {
        mockSocket._trigger('inbox:channel_updated', channelPayload());
      });

      expect(mockMutate).not.toHaveBeenCalled();
    });

    it('given a matching scope, the payload is written to the cache', () => {
      renderInboxSocket();

      act(() => {
        mockSocket._trigger('inbox:channel_updated', channelPayload());
      });

      expect(mockMutate).toHaveBeenCalledWith(
        CHANNEL_KEY,
        expect.any(Function),
        { revalidate: false }
      );
    });
  });

  // -------------------------------------------------------------------------
  // AC3: never silently drop an event mid-edit
  // -------------------------------------------------------------------------
  describe('stale-replay on editing end', () => {
    it('replays a dropped update once editing ends, with no page reload', () => {
      renderInboxSocket();

      act(() => {
        useEditingStore.getState().startEditing('doc-1', 'document');
      });

      act(() => {
        mockSocket._trigger('inbox:channel_updated', channelPayload());
      });

      // Dropped, not written, while editing is active.
      expect(mockMutate).not.toHaveBeenCalled();

      act(() => {
        useEditingStore.getState().endEditing('doc-1');
      });

      // Editing store subscription replays via a full revalidation of the
      // same key once every editing session ends.
      expect(mockMutate).toHaveBeenCalledWith(CHANNEL_KEY);
    });

    it('does not replay while any other editing session remains active', () => {
      renderInboxSocket();

      act(() => {
        useEditingStore.getState().startEditing('doc-1', 'document');
        useEditingStore.getState().startEditing('doc-2', 'document');
      });

      act(() => {
        mockSocket._trigger('inbox:channel_updated', channelPayload());
      });

      act(() => {
        useEditingStore.getState().endEditing('doc-1');
      });

      // doc-2 is still editing — isAnyEditing() is still true, so no replay yet.
      expect(mockMutate).not.toHaveBeenCalled();

      act(() => {
        useEditingStore.getState().endEditing('doc-2');
      });

      expect(mockMutate).toHaveBeenCalledWith(CHANNEL_KEY);
    });

    it('does not replay when no update was dropped', () => {
      renderInboxSocket();

      act(() => {
        useEditingStore.getState().startEditing('doc-1', 'document');
      });
      act(() => {
        useEditingStore.getState().endEditing('doc-1');
      });

      expect(mockMutate).not.toHaveBeenCalled();
    });
  });

  describe('hasLoadedRef race guard', () => {
    it('ignores events until hasLoadedRef.current is true', () => {
      renderInboxSocket({ hasLoadedRef: { current: false } });

      act(() => {
        mockSocket._trigger('inbox:channel_updated', channelPayload());
      });

      expect(mockMutate).not.toHaveBeenCalled();
    });
  });
});
