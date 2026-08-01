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
  setConfig: (next: AgentConfig) => void;
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
      void mutate(next, { revalidate: false });
    },
  };
}
