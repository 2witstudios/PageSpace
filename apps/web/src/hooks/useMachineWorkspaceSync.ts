'use client';

/**
 * Server-authoritative sync for a Machine's workspace list — entity
 * promotion (#2202), the successor to #2048's full-blob PUT/PATCH sync.
 *
 * The blob era needed `hydratedOnce` (a full-list replace must run at most
 * once per mount, or a later revalidation could wipe a workspace this
 * browser just created locally before its own create round-tripped),
 * `declinedBootstraps` (module-level, shared across this hook's TWO
 * mount-cardinalities — see below — so a second instance's bootstrap
 * decision agrees with the first's), and the `bootstrapped` echo dance. All
 * of that existed because the shared store was reconciled from a
 * full-replace blob with no ordering information.
 *
 * Every workspace/pane row now carries a per-MACHINE monotonic `rev`
 * (`machine-panes-store.ts`), and `useMachineWorkspaceStore`'s
 * `applyServerSnapshot`/`applyServerVerb` are REV-GATED: a payload at or
 * behind what this browser has already applied is simply dropped. That
 * makes every hydrate safely re-runnable — `revalidateOnFocus`/`onReconnect`
 * can stay on, a snapshot GET is no longer "only the first one counts", and
 * dual-mount (see below) needs no cross-instance coordination at all,
 * because the shared STORE's rev/pendingVerbs state is itself the
 * coordination — there is nothing left for a module-level `Set` to guard.
 *
 * Two exports, split because they have different mount-cardinality needs:
 *
 * - {@link useMachineWorkspaceSync} owns the stateful side effects (SWR
 *   fetch, the socket subscription). It is mounted MORE THAN ONCE for the
 *   machine the user has open: `DevelopmentSidebar` mounts one instance per
 *   machine ROW, and `MachineView` mounts one for the open machine. Harmless
 *   by construction now: both instances read/write the SAME shared store,
 *   and every write is rev-gated, so two instances hydrating from two GETs
 *   in either order converge on the same state.
 * - {@link useSyncedWorkspaceActions} pushes whichever {@link WorkspaceVerb}
 *   the local store action just queued onto `pendingVerbs` — no per-action
 *   diffing (the old `ChangedFields`/PATCH-then-404-POST fallback) needed,
 *   since a verb IS the diff.
 */

import { useEffect, useMemo } from 'react';
import useSWR from 'swr';
import { fetchWithAuth, post } from '@/lib/auth/auth-fetch';
import { useSocket } from './useSocket';
import { usePageSocketRoom } from './usePageSocketRoom';
import {
  useMachineWorkspaceStore,
  type MachineNodeScope,
  type OpenTerminalScope,
  type ServerWorkspaceDTO,
  type WorkspaceVerb,
} from '@/stores/machine-workspace/useMachineWorkspaceStore';

interface WorkspaceSnapshotResponse {
  workspaces: ServerWorkspaceDTO[];
  rev: number;
  /** Vestigial — the server always reports `true` post-#2202; kept only so an
   * old cached response shape doesn't need a type gate at every call site. */
  bootstrapped: boolean;
}

const fetcher = (url: string) =>
  fetchWithAuth(url).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? 'Failed to fetch workspaces');
    }
    return res.json() as Promise<WorkspaceSnapshotResponse>;
  });

/**
 * Fetches the server's workspace snapshot and keeps the store reconciled
 * with live `machine-workspace:verb` broadcasts. Returns nothing — like
 * `usePagePresence`, it's a side-effect hook.
 *
 * `machineId` is nullable so a caller can mount this unconditionally (React's
 * rules of hooks forbid calling it only for admins) while still skipping all
 * network/socket work for a non-admin viewer, who never sees the Terminal
 * tab this exists for — pass `null` rather than gating the call itself.
 */
export function useMachineWorkspaceSync(machineId: string | null): void {
  const ensureMachine = useMachineWorkspaceStore((state) => state.ensureMachine);
  const applyServerSnapshot = useMachineWorkspaceStore((state) => state.applyServerSnapshot);
  const applyServerVerb = useMachineWorkspaceStore((state) => state.applyServerVerb);

  const socket = useSocket();
  usePageSocketRoom(machineId ?? undefined);

  useEffect(() => {
    if (!machineId) return;
    ensureMachine(machineId);
  }, [machineId, ensureMachine]);

  const key = machineId ? `/api/machines/workspaces?machineId=${encodeURIComponent(machineId)}` : null;
  // Revalidating on focus/reconnect is now safe to leave ON: `applyServerSnapshot`
  // drops anything at or behind the rev already applied, so a late/stale
  // response from an earlier revalidation can never regress the store.
  const { data } = useSWR<WorkspaceSnapshotResponse>(key, fetcher);

  useEffect(() => {
    if (!machineId || !data) return;
    applyServerSnapshot(machineId, data.rev, data.workspaces);
  }, [machineId, data, applyServerSnapshot]);

  useEffect(() => {
    if (!socket || !machineId) return;
    // Narrowed copy for the closure below — a `string | null` parameter
    // doesn't stay narrowed inside a nested function expression.
    const mid = machineId;

    const onVerb = (payload: { machineId: string; rev: number; workspaceId: string; workspace: ServerWorkspaceDTO | null }) => {
      if (payload.machineId !== mid) return;
      applyServerVerb(mid, { rev: payload.rev, workspaceId: payload.workspaceId, workspace: payload.workspace });
    };

    socket.on('machine-workspace:verb', onVerb);
    return () => {
      socket.off('machine-workspace:verb', onVerb);
    };
  }, [socket, machineId, applyServerVerb]);
}

interface VerbResponse {
  rev: number;
  workspaceId: string;
  workspace: ServerWorkspaceDTO | null;
  applied: boolean;
}

/** GETs the current snapshot and applies it — the resync path a failed push
 * falls back to, so a dropped POST (network failure) doesn't leave this
 * browser permanently diverged from the server. */
async function resyncMachine(machineId: string): Promise<void> {
  try {
    const res = await fetchWithAuth(`/api/machines/workspaces?machineId=${encodeURIComponent(machineId)}`);
    if (!res.ok) return;
    const body = (await res.json()) as WorkspaceSnapshotResponse;
    useMachineWorkspaceStore.getState().applyServerSnapshot(machineId, body.rev, body.workspaces);
  } catch {
    // Best-effort — the next successful push, broadcast, or SWR revalidation reconciles.
  }
}

/**
 * Pushes one verb the local store already applied optimistically. On success,
 * the response IS a verb+rev payload — applied immediately via
 * `applyServerVerb` rather than waiting for this browser's own broadcast
 * echo, so convergence doesn't depend on socket delivery. `settleVerb` always
 * runs first (success or failure): either the push is confirmed and the
 * pending copy is no longer needed, or it's abandoned and a resync is the
 * recovery, not an indefinitely-retried pending verb.
 */
async function pushVerb(machineId: string, verb: WorkspaceVerb): Promise<void> {
  try {
    const res = await post<VerbResponse>('/api/machines/workspaces/verbs', { machineId, verb });
    useMachineWorkspaceStore.getState().settleVerb(machineId, verb);
    if (res.applied) {
      useMachineWorkspaceStore.getState().applyServerVerb(machineId, { rev: res.rev, workspaceId: res.workspaceId, workspace: res.workspace });
    }
  } catch {
    useMachineWorkspaceStore.getState().settleVerb(machineId, verb);
    void resyncMachine(machineId);
  }
}

/** The verb a local action just queued onto `pendingVerbs`, if any — `before`
 * is that machine's queue length captured immediately before calling the
 * local action. A local action is a pure no-op (unresolvable target) exactly
 * when nothing was appended. */
function verbJustQueued(machineId: string, before: number): WorkspaceVerb | undefined {
  const pending = useMachineWorkspaceStore.getState().pendingVerbs[machineId] ?? [];
  return pending.length > before ? pending[pending.length - 1] : undefined;
}

/**
 * Server-pushing wrappers around the workspace store's identity/layout
 * actions: call the real local action first (unchanged, instant, optimistic),
 * then push whichever verb it queued.
 *
 * Actions that stay purely local, never pushed: `setActiveWorkspace`,
 * `selectPane`, `dismissPicker`, `clearPanePrompt`, `ensureMachine`.
 */
export function useSyncedWorkspaceActions(machineId: string) {
  // Zustand action references are stable across renders; only `machineId`
  // ever changes, so `useMemo` gives callers (e.g. `useCallback` deps in
  // `TerminalPanes`) a stable object instead of a fresh one every render.
  const createWorkspaceLocal = useMachineWorkspaceStore((state) => state.createWorkspace);
  const removeWorkspaceLocal = useMachineWorkspaceStore((state) => state.removeWorkspace);
  const renameWorkspaceLocal = useMachineWorkspaceStore((state) => state.renameWorkspace);
  const splitRightLocal = useMachineWorkspaceStore((state) => state.splitRight);
  const splitDownLocal = useMachineWorkspaceStore((state) => state.splitDown);
  const closePaneLocal = useMachineWorkspaceStore((state) => state.closePane);
  const bindPaneTerminalLocal = useMachineWorkspaceStore((state) => state.bindPaneTerminal);
  const openTerminalLocal = useMachineWorkspaceStore((state) => state.openTerminal);

  return useMemo(() => {
    const pendingCount = () => (useMachineWorkspaceStore.getState().pendingVerbs[machineId] ?? []).length;
    const pushIfQueued = (before: number) => {
      const verb = verbJustQueued(machineId, before);
      if (verb) void pushVerb(machineId, verb);
    };

    return {
      createWorkspace(scope?: MachineNodeScope): string {
        const before = pendingCount();
        const id = createWorkspaceLocal(machineId, scope);
        pushIfQueued(before);
        return id;
      },
      removeWorkspace(workspaceId: string): void {
        const before = pendingCount();
        removeWorkspaceLocal(machineId, workspaceId);
        pushIfQueued(before);
      },
      renameWorkspace(workspaceId: string, name: string): void {
        const before = pendingCount();
        renameWorkspaceLocal(machineId, workspaceId, name);
        pushIfQueued(before);
      },
      splitRight(workspaceId: string, fromPaneId: string): void {
        const before = pendingCount();
        splitRightLocal(machineId, workspaceId, fromPaneId);
        pushIfQueued(before);
      },
      splitDown(workspaceId: string, fromPaneId: string): void {
        const before = pendingCount();
        splitDownLocal(machineId, workspaceId, fromPaneId);
        pushIfQueued(before);
      },
      closePane(workspaceId: string, paneId: string): void {
        const before = pendingCount();
        closePaneLocal(machineId, workspaceId, paneId);
        pushIfQueued(before);
      },
      bindPaneTerminal(workspaceId: string, paneId: string, scope: OpenTerminalScope, pendingPrompt?: string): boolean {
        const before = pendingCount();
        const bound = bindPaneTerminalLocal(machineId, workspaceId, paneId, scope, pendingPrompt);
        pushIfQueued(before);
        return bound;
      },
      /** `openTerminal` can materialize a new workspace, relocate an existing
       * one to front, or land in one already showing the session — the
       * pushed verb is whichever the local action queued, resolved the same
       * way the local action itself resolves "where does this session live".
       *
       * RETURNS that workspace's id, because the caller cannot derive it: a
       * session another workspace is already showing lands THERE
       * (`workspaceShowing`), not in its own `sessionWorkspaceId` workspace —
       * a spawn that assumed the derived id would navigate to a workspace
       * that doesn't contain the session, or doesn't exist. `undefined` only
       * when the machine itself is missing (nothing was opened).
       */
      openTerminal(scope: OpenTerminalScope): string | undefined {
        const before = pendingCount();
        openTerminalLocal(machineId, scope);
        pushIfQueued(before);
        const machine = useMachineWorkspaceStore.getState().machines[machineId];
        return machine?.activeWorkspaceId || undefined;
      },
    };
  }, [
    machineId,
    createWorkspaceLocal,
    removeWorkspaceLocal,
    renameWorkspaceLocal,
    splitRightLocal,
    splitDownLocal,
    closePaneLocal,
    bindPaneTerminalLocal,
    openTerminalLocal,
  ]);
}
