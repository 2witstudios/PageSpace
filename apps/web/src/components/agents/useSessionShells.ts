'use client';

import { useCallback } from 'react';
import useSWR from 'swr';
import type { ShellDTO } from '@pagespace/lib/agent-sessions/contract';

import { fetchWithAuth, post } from '@/lib/auth/auth-fetch';

/**
 * The named PTYs inside one conversation's sandbox.
 *
 * The inversion worth remembering: the SESSION owns the sandbox and every shell
 * in it shares that one Sprite, so a shell carries no sandbox identity of its
 * own — `{shellId}` is the whole address, for the list, the DELETE, and the
 * socket connect alike.
 *
 * Both mutations are optimistic with `rollbackOnError`, because both are
 * responses to a direct click: the tab has to appear (or disappear) in the same
 * tick the user acts, and the row IS the fallback if the round trip fails.
 */

const shellsPath = (sessionId: string) => `/api/agent-sessions/${encodeURIComponent(sessionId)}/shells`;
const shellPath = (sessionId: string, shellId: string) =>
  `${shellsPath(sessionId)}/${encodeURIComponent(shellId)}`;

type ShellsResponse = { shells: ShellDTO[] };

const EMPTY_SHELLS: ShellDTO[] = [];

const fetcher = async (url: string): Promise<ShellsResponse> => {
  const response = await fetchWithAuth(url);
  // No session row yet means no shells — the same lazy-creation fact
  // `useAgentSession` reads as status 'none', not a failure.
  if (response.status === 404) return { shells: [] };
  if (!response.ok) {
    const body: { error?: unknown } | null = await response.json().catch(() => null);
    throw new Error(typeof body?.error === 'string' ? body.error : `Failed to load shells: ${response.status}`);
  }
  return response.json();
};

/**
 * 404-as-success on DELETE. A 404 means the shell — or the whole sandbox that
 * held it — is already gone, which is this call's goal state. Treating it as a
 * failure is what made the old surface's stale rows permanently unremovable: the
 * kill rejected, the row rolled back, and retrying hit the same 404 forever.
 *
 * Real failures (5xx, network) still throw: the PTY may genuinely still be
 * running, and silently dropping its only row would strand it.
 */
async function deleteShell(sessionId: string, shellId: string): Promise<void> {
  const response = await fetchWithAuth(shellPath(sessionId, shellId), { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    const body: { error?: unknown } | null = await response.json().catch(() => null);
    throw new Error(typeof body?.error === 'string' ? body.error : 'Failed to close shell');
  }
}

/** Pure: the cached list minus one shell. An `undefined` cache passes through. */
export const withoutShell =
  (shellId: string) =>
  (current: ShellsResponse | undefined): ShellsResponse | undefined =>
    current ? { shells: current.shells.filter((shell) => shell.shellId !== shellId) } : current;

/** Pure: the cached list plus one shell, ignoring a shellId already present. */
export const withShell =
  (shell: ShellDTO) =>
  (current: ShellsResponse | undefined): ShellsResponse => {
    const shells = current?.shells ?? [];
    if (shells.some((existing) => existing.shellId === shell.shellId)) return { shells };
    return { shells: [...shells, shell] };
  };

export interface UseSessionShellsResult {
  shells: ShellDTO[];
  isLoading: boolean;
  error: Error | undefined;
  /** Opens a new PTY (auto-labelled server-side when `name` is omitted). */
  addShell: (name?: string) => Promise<ShellDTO | null>;
  removeShell: (shellId: string) => Promise<void>;
  mutate: () => void;
}

/**
 * @param sessionId the conversation whose shells these are, or null when nothing
 *   is open — which disables the fetch rather than requesting a placeholder.
 */
export function useSessionShells(sessionId: string | null | undefined): UseSessionShellsResult {
  const key = sessionId ? shellsPath(sessionId) : null;

  const { data, error, isLoading, mutate } = useSWR<ShellsResponse>(key, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 5_000,
  });

  const addShell = useCallback(
    async (name?: string): Promise<ShellDTO | null> => {
      if (!sessionId) return null;
      const created = await mutate(
        async (current) => {
          // The route answers `201 { shell }` — one shape, not two. The union
          // this used to accept (`{shell} | ShellDTO`) hedged against a response
          // the server never sends, and a cast covered the arm that could not
          // happen. That kind of "not sure what comes back" is how the tool
          // layer's realtime hop came to speak a shape its endpoint never used.
          const { shell } = await post<{ shell: ShellDTO }>(
            shellsPath(sessionId),
            name ? { name } : {},
          );
          return withShell(shell)(current);
        },
        {
          // No optimistic row: the server mints the shellId (it is the PTY's
          // address, and the sandbox may still be provisioning), and a tab that
          // cannot be connected to yet is worse than a tab that appears a beat
          // late.
          revalidate: false,
          rollbackOnError: true,
        },
      );
      return created?.shells.at(-1) ?? null;
    },
    [sessionId, mutate],
  );

  const removeShell = useCallback(
    async (shellId: string): Promise<void> => {
      if (!sessionId) return;
      await mutate(
        async (current) => {
          await deleteShell(sessionId, shellId);
          return withoutShell(shellId)(current) ?? { shells: [] };
        },
        {
          // Synchronous removal: the user clicked close, so the tab goes now.
          optimisticData: (current?: ShellsResponse) => withoutShell(shellId)(current) ?? { shells: [] },
          revalidate: false,
          rollbackOnError: true,
        },
      );
    },
    [sessionId, mutate],
  );

  return {
    shells: data?.shells ?? EMPTY_SHELLS,
    isLoading: isLoading && !data,
    error: error as Error | undefined,
    addShell,
    removeShell,
    mutate: () => {
      void mutate();
    },
  };
}
