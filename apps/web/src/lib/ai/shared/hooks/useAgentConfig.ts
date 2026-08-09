/**
 * useAgentConfig - Shared, SWR-backed hook for a page agent's config.
 *
 * SWR's cache is keyed by URL, so every mounted consumer of the SAME
 * `pageId` — the page's own Settings tab, and every pane showing that
 * agent — reads the identical cache entry: one fetch, one in-flight state,
 * one value. `setConfig` writes through that SAME cache (no revalidate,
 * since the caller already has the server's own fresh response — see
 * `PageAgentSettingsTab`'s `onSubmit`, which PATCHes itself and hands back
 * the persisted result), so a save from ANY one consumer is instantly
 * visible in every other one — a save in one pane, or the page's own
 * Settings tab, cannot be shadowed by a stale copy held in another (the gap
 * a per-instance `useState` fetch would have: two panes on the same agent
 * would otherwise each hold their own independent snapshot).
 *
 * `pageId: null` — the global assistant, which has no page and so no
 * config to fetch — disables the SWR key entirely (mirrors `useConversations`'s
 * own `enabled`/null-key pattern), so a pane hosting the assistant can call
 * this hook unconditionally (stable hook order across an agent switch)
 * without ever issuing a request.
 */
import useSWR from 'swr';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { AgentConfig } from '../chat-types';

function agentConfigKey(pageId: string | null): string | null {
  return pageId === null ? null : `/api/pages/${pageId}/agent-config`;
}

interface UseAgentConfigResult {
  config: AgentConfig | null;
  /**
   * Accepts a plain value OR an updater `(current) => next` — the updater
   * form reads the LIVE SWR cache value at the moment it actually runs,
   * not whatever `config` a caller's closure captured when it was created.
   * Two mounted consumers of the SAME pageId saving DIFFERENT fields
   * concurrently each hold their own stale closure of `config` from
   * before either save started; whichever finishes last spreading that
   * closure into a plain value here would publish a snapshot missing the
   * other's meanwhile-arrived change, making it disappear from the shared
   * cache (and every mounted consumer) even though both sparse PATCHes
   * persisted correctly server-side (review finding — chatgpt-codex-
   * connector on PR #2299, round 22 — see PageAgentSettingsTab's onSubmit).
   * (Matches SWR's own MutatorCallback signature — `undefined`, not
   * `null`, for "no value yet", since it's passed straight through.)
   */
  setConfig: (next: AgentConfig | ((current: AgentConfig | undefined) => AgentConfig)) => void;
  /**
   * Re-fetches and reconciles the cache with whatever the server actually
   * holds right now. Needed because `setConfig`'s optimistic updates can
   * still end up wrong for a reason merging alone can't fix: two mounted
   * surfaces PATCHing the SAME field with different values race not just
   * on which save STARTS first, but on which HTTP response ARRIVES first
   * — that need not match DB-write order (the earlier write can have the
   * slower response). Whichever completion applies last here wins the
   * cache regardless of which write actually landed last in the DB. Call
   * this after a save to let the fetch settle the cache to ground truth
   * once any overlapping sibling save has also had a chance to land
   * (review finding — chatgpt-codex-connector on PR #2299, round 23).
   */
  revalidate: () => void;
}

export function useAgentConfig(pageId: string | null): UseAgentConfigResult {
  const { data, mutate } = useSWR<AgentConfig>(
    agentConfigKey(pageId),
    async (url) => {
      const response = await fetchWithAuth(url);
      if (!response.ok) throw new Error('Failed to load agent config');
      return response.json();
    },
    { revalidateOnFocus: false, revalidateOnReconnect: false },
  );

  return {
    config: data ?? null,
    setConfig: (next) => {
      // SWR's own mutate natively accepts either shape — passed straight
      // through so the updater form runs against whatever the cache
      // actually holds when it executes.
      void mutate(next, { revalidate: false });
    },
    // No-argument mutate() re-fetches the key and replaces the cache with
    // the response — SWR's own revalidate primitive.
    revalidate: () => {
      void mutate();
    },
  };
}
