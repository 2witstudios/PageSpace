/**
 * Thread Inbox Store
 *
 * Tracks unread thread roots per channel/DM context so the inbox sidebar can
 * surface a per-row "thread badge" without bumping the existing top-level
 * unread count. The server emits `thread_updated` inbox events to followers
 * (excluding the reply author); this store accumulates those events into a
 * `(source, contextId, rootMessageId)` triple and clears the contribution
 * when the user opens the thread panel for that root.
 *
 * Keyed deliberately by all three fields:
 *   - `(source, contextId)` identifies the channel or DM row to badge.
 *   - `rootMessageId` lets a single channel carry multiple unread thread
 *     roots; opening one thread should NOT clear the others.
 *
 * The store is intentionally pure: realtime fan-in lives in `useInboxSocket`
 * and panel-open clearing lives where ThreadPanel mounts. Tests can drive it
 * directly via `useThreadInboxStore.getState()`.
 */

import { create } from 'zustand';

export type ThreadInboxSource = 'channel' | 'dm';

interface BumpArgs {
  source: ThreadInboxSource;
  contextId: string;
  rootMessageId: string;
}

interface ClearArgs {
  source: ThreadInboxSource;
  contextId: string;
  rootMessageId: string;
}

interface ContextUnread {
  /** Per-root counts within this context */
  byRoot: Record<string, number>;
}

type Key = string;

const buildKey = (source: ThreadInboxSource, contextId: string): Key =>
  `${source}:${contextId}`;

export interface ThreadInboxState {
  /** Per-context unread-thread state, keyed by `${source}:${contextId}` */
  contexts: Record<Key, ContextUnread>;
  /**
   * Bump the per-root count for an inbox `thread_updated` arrival. Does NOT
   * suppress duplicates by reply id; the calling event listener guarantees
   * one bump per fan-out hop.
   */
  bump: (args: BumpArgs) => void;
  /**
   * Clear the count for one specific root (e.g. the user opens the thread
   * panel for it). Other roots in the same context are unaffected.
   */
  clearRoot: (args: ClearArgs) => void;
  /**
   * Convenience accessor: total unread thread roots in a context. A "root"
   * with count 0 does not contribute. Returns 0 when the context is empty.
   */
  contextUnreadCount: (source: ThreadInboxSource, contextId: string) => number;
}

export const useThreadInboxStore = create<ThreadInboxState>((set, get) => ({
  contexts: {},
  bump: ({ source, contextId, rootMessageId }) => {
    // Inbox events from realtime are programmatic and should always carry a
    // non-empty root id; an empty/null payload here is a sentinel for an
    // upstream bug, not user input. Drop silently rather than poison the
    // store with "", "null", or "undefined" keys that would inflate badge
    // counts and never get cleared by a panel-mount with the real root id.
    if (!rootMessageId) return;
    set((state) => {
      const key = buildKey(source, contextId);
      const ctx = state.contexts[key] ?? { byRoot: {} };
      const current = ctx.byRoot[rootMessageId] ?? 0;
      return {
        contexts: {
          ...state.contexts,
          [key]: {
            byRoot: { ...ctx.byRoot, [rootMessageId]: current + 1 },
          },
        },
      };
    });
  },
  clearRoot: ({ source, contextId, rootMessageId }) =>
    set((state) => {
      const key = buildKey(source, contextId);
      const ctx = state.contexts[key];
      if (!ctx) return state;
      if (ctx.byRoot[rootMessageId] === undefined) return state;
      const { [rootMessageId]: _removed, ...remaining } = ctx.byRoot;
      void _removed;
      return {
        contexts: {
          ...state.contexts,
          [key]: { byRoot: remaining },
        },
      };
    }),
  contextUnreadCount: (source, contextId) => {
    const ctx = get().contexts[buildKey(source, contextId)];
    if (!ctx) return 0;
    let n = 0;
    for (const k of Object.keys(ctx.byRoot)) {
      if (ctx.byRoot[k] > 0) n += 1;
    }
    return n;
  },
}));
