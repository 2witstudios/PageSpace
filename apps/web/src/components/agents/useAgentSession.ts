'use client';

import { useCallback } from 'react';
import useSWR from 'swr';
import type { AgentSessionDTO, SandboxStatus } from '@pagespace/lib/agent-sessions/contract';

import { fetchWithAuth, post } from '@/lib/auth/auth-fetch';
import { deriveSandboxStatus } from '@/lib/agents/session-status';

/**
 * One conversation's sandbox, if it has one.
 *
 * `sessionId` IS the conversation id — the same string, not a lookup (see the
 * agent-sessions contract). So a component holding the selected conversation
 * already holds this hook's argument, and there is no "which id?" moment
 * anywhere in the call.
 *
 * ## 404 is not an error
 *
 * The single most important behaviour here. Sessions are created LAZILY — the
 * row appears the first time something actually needs compute — so the
 * overwhelming majority of conversations have no session row at all, forever.
 * A 404 from this endpoint therefore means "no sandbox yet", which is
 * `status: 'none'`, which is a perfectly ordinary thing to render. Treating it
 * as a failure would paint an error state on nearly every conversation in the
 * tree, and would make the surface look broken in its resting state.
 *
 * Genuine failures (5xx, network, malformed) still surface as `error`: those
 * mean "we don't know", which is not the same as "there isn't one", and a user
 * about to start a sandbox deserves to be told the difference.
 */

/** Route family: flat, not nested under the agent — the row knows its own agent. */
const sessionPath = (sessionId: string) => `/api/agent-sessions/${encodeURIComponent(sessionId)}`;

/**
 * `undefined` is the cache value for "asked, and there is no session" — SWR
 * treats it as loaded-with-no-data, which is exactly the fact. Distinguishing it
 * from "not asked yet" is `isLoading`'s job.
 */
type SessionResponse = { session: AgentSessionDTO | null };

const fetcher = async (url: string): Promise<SessionResponse> => {
  const response = await fetchWithAuth(url);
  // The lazy-creation contract: absent is a state, not a fault.
  if (response.status === 404) return { session: null };
  if (!response.ok) {
    const body: { error?: unknown } | null = await response.json().catch(() => null);
    throw new Error(typeof body?.error === 'string' ? body.error : `Failed to load sandbox: ${response.status}`);
  }
  // The route has ONE success shape: `{ session }`, with `session: null` for a
  // conversation that never acquired a sandbox. This used to accept the bare DTO
  // too, "so the hook does not become the reason a route has to pick one" — but
  // the route had already picked, and tolerating a shape nothing sends only
  // hides the day the two stop agreeing. That is not hypothetical here: the
  // tool layer's realtime hop spent this whole rebuild speaking a format its
  // endpoint never used, and permissive parsing on the client is what keeps
  // that class of break silent.
  return (await response.json()) as SessionResponse;
};

export interface UseAgentSessionResult {
  /** The row, or null when this conversation has never acquired a sandbox. */
  session: AgentSessionDTO | null;
  /** Always safe to render — `'none'` covers absent, loading, and 404 alike. */
  status: SandboxStatus;
  isLoading: boolean;
  /** Only ever a REAL failure. A missing session is not one. */
  error: Error | undefined;
  /**
   * Create-or-attach, idempotent. POSTing the same path is how a caller says
   * "I'm about to need compute" — the server ensures the row (and, on the paths
   * that need it, the sandbox) and returns the same session for concurrent
   * callers.
   */
  ensureSession: () => Promise<AgentSessionDTO | null>;
  mutate: () => void;
}

/**
 * @param sessionId the selected conversation's id, or null when nothing is open.
 *   Null disables the fetch entirely rather than fetching a placeholder.
 */
export function useAgentSession(sessionId: string | null | undefined): UseAgentSessionResult {
  const key = sessionId ? sessionPath(sessionId) : null;

  const { data, error, isLoading, mutate } = useSWR<SessionResponse>(key, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 5_000,
  });

  const session = data?.session ?? null;

  const ensureSession = useCallback(async (): Promise<AgentSessionDTO | null> => {
    if (!sessionId) return null;
    const { session: ensured } = await post<SessionResponse>(sessionPath(sessionId));
    // Write the server's answer straight into the cache: provisioning is the one
    // moment where a stale 'none' would be actively misleading (the chip would
    // still offer to start a sandbox that is already starting).
    await mutate({ session: ensured ?? null }, { revalidate: false });
    return ensured ?? null;
  }, [sessionId, mutate]);

  return {
    session,
    status: deriveSandboxStatus(session),
    isLoading: isLoading && !data,
    error: error as Error | undefined,
    ensureSession,
    mutate: () => {
      void mutate();
    },
  };
}
