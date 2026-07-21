'use client';

import { useCallback } from 'react';
import useSWR, { mutate } from 'swr';
import { fetchWithAuth, post } from '@/lib/auth/auth-fetch';
import type { AgentRuntimeType } from '@pagespace/lib/services/machines/agent-terminal-types';

export interface AgentTerminal {
  // The row's own id — used client-side as the conversation id for
  // chat-surface (`pagespace`) terminals.
  id: string;
  name: string;
  // A raw DB value, not narrowed to AgentRuntimeType — a row can carry an
  // agentType from a since-retired AGENT_LAUNCH_SPECS entry (e.g. the removed
  // 'pagespace-cli'). Callers check `isAgentRuntimeType(agentType)` before
  // treating it as a launchable one (see WorkspaceLeaves.tsx).
  agentType: string;
  createdAt: string;
}

const fetcher = (url: string) =>
  fetchWithAuth(url).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? 'Failed to fetch terminals');
    }
    return res.json() as Promise<{ agentTerminals: AgentTerminal[] }>;
  });

function buildQuery(machineId: string, projectName?: string | null, branchName?: string | null): string {
  const params = new URLSearchParams({ machineId });
  if (projectName) params.set('projectName', projectName);
  if (branchName) params.set('branchName', branchName);
  return params.toString();
}

/** The hook's SWR cache value — `undefined` until the first GET lands. */
type TerminalList = { agentTerminals: AgentTerminal[] } | undefined;

/**
 * The shared DELETE, with 404-as-success: a 404 means the session — or the
 * project/branch checkout that held it — is already gone server-side, which is
 * this call's goal state. Treating it as an error made a workspace holding a
 * stale pane permanently unremovable: the kill rejected, the confirm dialog
 * stayed open, and retrying hit the same 404 forever — an unremovable listing,
 * the exact bug class this surface exists to kill. Real failures (5xx,
 * network) still throw: the agent may genuinely still be running (and
 * billing), and silently dropping its only row would strand it. Reading the
 * status needs `fetchWithAuth` directly — the `del()` helper throws a plain
 * `Error` with no status attached (see `pushWorkspaceUpdate`'s doc in
 * useMachineWorkspaceSync for the same choice).
 */
async function deleteAgentTerminalRequest(
  machineId: string,
  scope: { projectName?: string | null; branchName?: string | null; name: string },
): Promise<void> {
  const query = buildQuery(machineId, scope.projectName, scope.branchName);
  const response = await fetchWithAuth(
    `/api/machines/agent-terminals?${query}&name=${encodeURIComponent(scope.name)}`,
    { method: 'DELETE' },
  );
  if (!response.ok && response.status !== 404) {
    const body: { error?: unknown } | null = await response.json().catch(() => null);
    throw new Error(typeof body?.error === 'string' ? body.error : 'Failed to remove terminal');
  }
}

/** Pure: the cached list minus the named row(s); `undefined` cache passes through. */
export const withoutSessions =
  (names: ReadonlySet<string>) =>
  (list: TerminalList): TerminalList =>
    list ? { agentTerminals: list.agentTerminals.filter((terminal) => !names.has(terminal.name)) } : list;

/** Pure: the cached list minus the named row; `undefined` cache passes through. */
export const withoutSession = (name: string) => withoutSessions(new Set([name]));

/**
 * Per-key bookkeeping for kills currently in flight (or settled while a
 * same-key sibling is still in flight). SWR hands every settle's
 * `populateCache` the ORIGINAL committed snapshot (`_c`, captured before any
 * optimistic update on the key) — so with two concurrent kills, the
 * latest-started one's commit would write the OTHER kill's row straight back
 * into the cache, and only the detached revalidation would repair it. Filtering
 * the committed snapshot through this registry keeps every sibling kill's row
 * out of whatever any settle commits.
 *
 * Bookkeeping details, each covering a verified failure mode:
 *
 * - `perName` holds COUNTS, not a set: two concurrent kills of one name (a
 *   pane close racing the sidebar's remove of the same session) register
 *   twice, and the first duplicate failing must not deregister the name while
 *   the second is still in flight — its later success would commit a snapshot
 *   WITH the row.
 * - `succeeded` names outlive their own settle: a sibling that started
 *   earlier settles later with a snapshot that still contains them.
 * - A FAILED kill deregisters its name (rollback means that row is supposed
 *   to come back) — but SWR's own repair is not enough: `rollbackOnError`
 *   writes the pre-kill snapshot back WITHOUT consulting `populateCache`
 *   (resurrecting succeeded siblings), and a non-latest mutation's rollback
 *   and revalidation are BOTH skipped by SWR's timestamp guard (leaving a
 *   genuinely-failed kill's row invisible while its agent runs and bills).
 *   So the failed release hands the caller a compensating filter set — see
 *   {@link withKillRegistered} — to re-drop succeeded siblings and force one
 *   reconciling revalidation.
 * - The entry is cleared once the key has zero kills in flight; the detached
 *   revalidation reconciles any longer-term drift with server truth.
 */
const killsInFlight = new Map<string, { inflight: number; perName: Map<string, number>; succeeded: Set<string> }>();

/** Every name any settle's commit must keep filtering: still-in-flight kills plus already-succeeded ones. */
function activeKillNames(key: string): ReadonlySet<string> | null {
  const entry = killsInFlight.get(key);
  if (!entry) return null;
  return new Set([...entry.perName.keys(), ...entry.succeeded]);
}

function registerKill(key: string, name: string): (failed: boolean) => ReadonlySet<string> {
  let entry = killsInFlight.get(key);
  if (!entry) {
    entry = { inflight: 0, perName: new Map(), succeeded: new Set() };
    killsInFlight.set(key, entry);
  }
  entry.inflight += 1;
  entry.perName.set(name, (entry.perName.get(name) ?? 0) + 1);
  return (failed: boolean) => {
    entry.inflight -= 1;
    const remaining = (entry.perName.get(name) ?? 1) - 1;
    if (remaining <= 0) entry.perName.delete(name);
    else entry.perName.set(name, remaining);
    if (!failed) entry.succeeded.add(name);
    const filterNames = new Set([...entry.perName.keys(), ...entry.succeeded]);
    if (entry.inflight === 0) killsInFlight.delete(key);
    return filterNames;
  };
}

/**
 * Runs `mutation` with its kill registered for the key's populateCache
 * filter. On FAILURE, calls `compensate` with the post-release filter set —
 * the caller issues a cache write that re-drops every still-relevant kill's
 * row (undoing SWR's snapshot rollback resurrecting succeeded siblings)
 * while leaving the failed row alone, and forces a reconciling revalidation
 * (covering the non-latest-mutation case where SWR skips both its rollback
 * and its revalidation).
 */
async function withKillRegistered(
  key: string,
  name: string,
  mutation: () => Promise<unknown>,
  compensate: (filterNames: ReadonlySet<string>) => void,
): Promise<void> {
  const release = registerKill(key, name);
  let failed = false;
  try {
    await mutation();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const filterNames = release(failed);
    if (failed) compensate(filterNames);
  }
}

/**
 * The optimistic-mutation contract every session removal runs under. The
 * sidebar's "unclaimed session" rows are a set-difference between this cache
 * and the workspace store's panes — a pane close mutates the store
 * synchronously, so the row must leave this cache in the SAME tick, or the
 * session resurfaces as an orphan row for at least a frame (and forever if
 * the round-trip fails silently). Mutate applies `optimisticData`
 * synchronously within the call, which is what makes close-and-kill one
 * batched render.
 *
 * - `optimisticData` filters the DISPLAYED data, not the committed snapshot:
 *   with two concurrent kills on one key (a workspace removal killing several
 *   same-scope sessions), the second kill's committed snapshot still holds
 *   the first kill's row — filtering displayed data keeps it hidden.
 * - `populateCache` commits the committed snapshot filtered through the
 *   {@link killsInFlight} registry, not just this kill's own name: the
 *   snapshot SWR hands every settle predates ALL optimistic updates on the
 *   key, so filtering one name would resurrect a concurrently-killed sibling
 *   (leaving the detached revalidation as the only — possibly delayed,
 *   possibly failing — repair).
 * - `rollbackOnError` restores the row when the DELETE genuinely fails — the
 *   unclaimed fallback row IS the recovery path (still reachable, still
 *   removable), and the error still throws to the caller.
 * - `revalidate` reconciles with server truth after settling; it is detached
 *   in SWR 2.x, so a transient refetch failure can never turn a completed
 *   teardown into a rejection.
 */
export const killMutateOptions = (key: string, name: string) => ({
  // SWR's MutatorOptions require a non-undefined cache value from these — an
  // unpopulated cache filters to an empty list (the row wasn't shown anyway),
  // and the detached revalidation reconciles it with server truth.
  optimisticData: (_committed: TerminalList, displayed: TerminalList) =>
    withoutSession(name)(displayed) ?? { agentTerminals: [] },
  // `_result` is `unknown` (not `void`): the DELETE resolves to nothing, but
  // both mutate flavors this feeds — the global one (MutationData inferred
  // from the promise) and a hook's bound one (no per-call generic in SWR
  // 2.4's KeyedMutator) — must accept this options object as-is.
  populateCache: (_result: unknown, committed: TerminalList) =>
    withoutSessions(activeKillNames(key) ?? new Set([name]))(committed) ?? { agentTerminals: [] },
  rollbackOnError: true,
  revalidate: true,
});

/**
 * Kills a session addressed by its OWN (project, branch, name) scope — the
 * session's real identity (`machine_agent_terminals`' unique index).
 *
 * The hook's `removeAgentTerminal` below DELETEs under whatever scope the hook
 * instance was mounted with — right for undoing a spawn that same instance
 * just made, wrong for killing an arbitrary pane's session: a pane's scope can
 * differ from its workspace's (a restored server layout can hold panes bound
 * at other checkouts), and DELETEing that pane's `name` under the WORKSPACE's
 * scope would kill a different terminal that happens to share the name — or
 * nothing — while the intended one lives on as an unclaimed session.
 *
 * The DELETE runs inside an optimistic mutation (see {@link killMutateOptions})
 * so the row leaves the killed scope's list synchronously — the same tick as
 * the caller's `closePane` — and rolls back only on genuine failure.
 */
export async function killAgentTerminal(
  machineId: string,
  scope: { projectName?: string | null; branchName?: string | null; name: string },
): Promise<void> {
  const key = `/api/machines/agent-terminals?${buildQuery(machineId, scope.projectName, scope.branchName)}`;
  await withKillRegistered(
    key,
    scope.name,
    () => mutate(key, deleteAgentTerminalRequest(machineId, scope), killMutateOptions(key, scope.name)),
    (filterNames) =>
      void mutate(
        key,
        (current: TerminalList) => withoutSessions(filterNames)(current) ?? { agentTerminals: [] },
        { revalidate: true },
      ).catch(() => {}),
  );
}

/**
 * Runtime tier of the Terminal workspace navigator — named, pluggable-agent-
 * typed PTY sessions at ANY of the three universal Terminal scopes: neither
 * `projectName` nor `branchName` set targets machine scope, `projectName`
 * alone targets project scope, both set targets branch scope. Pass a `null`
 * `machineId` to disable fetching entirely (e.g. a collapsed navigator node).
 */
export function useAgentTerminals(machineId: string | null, projectName?: string | null, branchName?: string | null) {
  const key = machineId ? `/api/machines/agent-terminals?${buildQuery(machineId, projectName, branchName)}` : null;

  const { data, error, isLoading, mutate } = useSWR(key, fetcher, {
    revalidateOnFocus: false,
  });

  const addAgentTerminal = useCallback(
    async (name: string, agentType: AgentRuntimeType) => {
      if (!machineId) throw new Error('No active machine');
      const result = await post<{ agentTerminal: { id: string; name: string; agentType: AgentRuntimeType; resumed: boolean } }>(
        '/api/machines/agent-terminals',
        { machineId, projectName: projectName ?? undefined, branchName: branchName ?? undefined, name, agentType },
      );
      await mutate();
      return result.agentTerminal;
    },
    [machineId, projectName, branchName, mutate],
  );

  // The hook's BOUND mutate (not the global one): it targets this instance's
  // cache through whatever SWR provider is active, and shares the exact
  // optimistic/rollback/404-as-success contract as `killAgentTerminal` —
  // a row already dead server-side must still be removable.
  const removeAgentTerminal = useCallback(
    async (name: string) => {
      if (!machineId || !key) throw new Error('No active machine');
      // `.then(() => undefined)` shapes the DELETE into the Promise<Data |
      // undefined> the bound mutate accepts; `populateCache` supplies the real
      // next cache value, so the undefined result is never written as data.
      await withKillRegistered(
        key,
        name,
        () =>
          mutate(
            deleteAgentTerminalRequest(machineId, { projectName, branchName, name }).then(() => undefined),
            killMutateOptions(key, name),
          ),
        (filterNames) =>
          void mutate(
            (current) => withoutSessions(filterNames)(current) ?? { agentTerminals: [] },
            { revalidate: true },
          ).catch(() => {}),
      );
    },
    [machineId, key, projectName, branchName, mutate],
  );

  return {
    agentTerminals: data?.agentTerminals ?? [],
    isLoading,
    error: error as Error | undefined,
    mutate,
    addAgentTerminal,
    removeAgentTerminal,
  };
}
