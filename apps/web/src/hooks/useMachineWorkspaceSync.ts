'use client';

/**
 * Server-authoritative sync for a Machine's workspace list (#2048) — the
 * successor to PR #2031's `localStorage`-only `useMachineWorkspaceStore`.
 *
 * Two exports, split because they have different mount-cardinality needs:
 *
 * - {@link useMachineWorkspaceSync} owns the stateful side effects (SWR fetch,
 *   the one-time bootstrap race, the socket subscription) and must be mounted
 *   exactly ONCE per machine — at `MachineView`, the true per-machine root
 *   that survives Terminal-tab unmount/remount (Radix `TabsContent` unmounts
 *   inactive tabs; `MachineView` doesn't).
 * - {@link useSyncedWorkspaceActions} has no internal state to coordinate (see
 *   its own doc for why), so it's safe to call from every component that
 *   mutates a workspace — `WorkspaceLeaves` (sidebar) and `TerminalPanes`
 *   (pane grid) each call it independently.
 */

import { useEffect, useMemo, useRef } from 'react';
import useSWR from 'swr';
import { fetchWithAuth, post, del } from '@/lib/auth/auth-fetch';
import { useSocket } from './useSocket';
import { usePageSocketRoom } from './usePageSocketRoom';
import {
  useMachineWorkspaceStore,
  workspacesOf,
  workspaceShowing,
  sessionWorkspaceId,
  type MachineNodeScope,
  type OpenTerminalScope,
  type ServerWorkspaceDTO,
  type TerminalColumnState,
} from '@/stores/machine-workspace/useMachineWorkspaceStore';

interface WorkspaceListResponse {
  workspaces: ServerWorkspaceDTO[];
  bootstrapped: boolean;
}

interface BootstrapResponse {
  claimed: boolean;
  workspaces: ServerWorkspaceDTO[];
}

const fetcher = (url: string) =>
  fetchWithAuth(url).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? 'Failed to fetch workspaces');
    }
    return res.json() as Promise<WorkspaceListResponse>;
  });

/** Strips local-only pane state (`pendingPrompt`) before a layout crosses the
 * wire — the server's layout DTO has no such field, and a starting prompt not
 * yet typed into its PTY must never be persisted or broadcast to other browsers. */
function toWireColumns(columns: TerminalColumnState[]) {
  return columns.map((column) => ({
    id: column.id,
    panes: column.panes.map((pane) => ({ id: pane.id, scope: pane.scope })),
  }));
}

/**
 * Fetches the server's workspace list, seeds it from this browser's local
 * history on first-ever load for this machine (see
 * `machine-workspaces.ts`'s module doc for the claim/race design this relies
 * on), and keeps the store reconciled with live `machine-workspace:*`
 * broadcasts. Returns nothing — like `usePagePresence`, it's a side-effect hook.
 *
 * `machineId` is nullable so a caller can mount this unconditionally (React's
 * rules of hooks forbid calling it only for admins) while still skipping all
 * network/socket work for a non-admin viewer, who never sees the Terminal
 * tab this exists for — pass `null` rather than gating the call itself.
 */
export function useMachineWorkspaceSync(machineId: string | null): void {
  const ensureMachine = useMachineWorkspaceStore((state) => state.ensureMachine);
  const hydrateFromServer = useMachineWorkspaceStore((state) => state.hydrateFromServer);
  const applyServerUpsert = useMachineWorkspaceStore((state) => state.applyServerUpsert);
  const applyServerDelete = useMachineWorkspaceStore((state) => state.applyServerDelete);

  const socket = useSocket();
  usePageSocketRoom(machineId ?? undefined);

  // Guards against retrying the bootstrap POST on every SWR revalidation once
  // this browser has already tried it for this machine — not against the
  // cross-browser race, which the server's claim table (not this ref) resolves.
  const bootstrapAttempted = useRef(false);

  // `hydrateFromServer` is a FULL-LIST replace that deliberately drops any
  // local-only workspace not in the server's list (see `mergeServerWorkspaces`'s
  // doc — correct for a one-time initial hydrate, wrong for a background
  // refresh). SWR's `data` can change more than once for the SAME machine —
  // `revalidateOnReconnect` defaults true, so a brief network drop refetches —
  // and re-running the full-replace on a LATER revalidation would silently
  // wipe a workspace this browser just created locally whose own create
  // request hasn't round-tripped (and broadcast) yet. So this only ever runs
  // ONCE per mount; every subsequent change to the store comes from the socket
  // subscription below. Safe as a plain ref (not reset on `machineId` change)
  // because this hook is mounted once per machine at `MachineView`, which
  // `MachineKeepAliveHost` keeps as one distinct component instance per
  // machine rather than reusing one instance across different machineIds.
  const hydratedOnce = useRef(false);

  useEffect(() => {
    if (!machineId) return;
    ensureMachine(machineId);
  }, [machineId, ensureMachine]);

  const key = machineId ? `/api/machines/workspaces?machineId=${encodeURIComponent(machineId)}` : null;
  const { data } = useSWR<WorkspaceListResponse>(key, fetcher, { revalidateOnFocus: false });

  useEffect(() => {
    if (!machineId || !data || hydratedOnce.current) return;

    if (data.bootstrapped) {
      hydratedOnce.current = true;
      hydrateFromServer(machineId, data.workspaces);
      return;
    }

    if (bootstrapAttempted.current) return;
    bootstrapAttempted.current = true;

    const local = useMachineWorkspaceStore.getState().machines[machineId];
    const payload = (local ? workspacesOf(local) : []).map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      scope: workspace.scope,
      columns: toWireColumns(workspace.columns),
    }));

    post<BootstrapResponse>('/api/machines/workspaces/bootstrap', { machineId, workspaces: payload })
      .then((res) => {
        // This request's own resolution races the socket subscription below:
        // apps/realtime's `io.to(channelId).emit(...)` broadcasts this exact
        // bootstrap claim back to every socket in the room, INCLUDING this
        // browser's own — so `onBootstrapped` can already have hydrated (and
        // set `hydratedOnce`) before this `.then()` runs. Re-running the
        // full-list replace here too would risk wiping a workspace created in
        // that window.
        if (hydratedOnce.current) return;
        hydratedOnce.current = true;
        hydrateFromServer(machineId, res.workspaces);
      })
      .catch(() => {
        // Retry on the next data change (e.g. a manual refresh) rather than
        // leaving this machine permanently un-bootstrapped over a transient failure.
        bootstrapAttempted.current = false;
      });
  }, [machineId, data, hydrateFromServer]);

  useEffect(() => {
    if (!socket || !machineId) return;
    // Narrowed copy for the closures below — a `string | null` parameter
    // doesn't stay narrowed inside nested function expressions.
    const mid = machineId;

    const onCreated = (payload: ServerWorkspaceDTO & { machineId: string }) => {
      if (payload.machineId !== mid) return;
      applyServerUpsert(mid, payload);
    };
    const onUpdated = (payload: {
      machineId: string;
      workspaceId: string;
      name?: string;
      columns?: TerminalColumnState[];
    }) => {
      if (payload.machineId !== mid) return;
      // `updated` only carries whichever of name/columns actually changed —
      // fill in the rest from what this browser already has for it. It NEVER
      // carries `scope` (immutable, so the PATCH route never re-sends it), so
      // an `updated` event can only ever be applied to a workspace this
      // browser already knows about — there is no safe default for `scope`
      // (defaulting to machine-scope would misfile a project/branch-scoped
      // workspace under the wrong sidebar node) nor for missing name/columns
      // (defaulting to `''`/`[]` would plant a broken, zero-pane entry). If
      // this browser hasn't hydrated the workspace yet (e.g. it missed the
      // `created` broadcast on a reconnect), skip and wait for a `created`
      // event or the next full hydration to introduce it correctly.
      const current = useMachineWorkspaceStore.getState().machines[mid]?.workspaces[payload.workspaceId];
      if (!current) return;
      applyServerUpsert(mid, {
        id: payload.workspaceId,
        name: payload.name ?? current.name,
        scope: current.scope,
        columns: payload.columns ?? current.columns,
      });
    };
    const onDeleted = (payload: { machineId: string; workspaceId: string }) => {
      if (payload.machineId !== mid) return;
      applyServerDelete(mid, payload.workspaceId);
    };
    const onBootstrapped = (payload: { machineId: string; workspaces: ServerWorkspaceDTO[] }) => {
      if (payload.machineId !== mid) return;
      // `io.to(channelId).emit(...)` (apps/realtime) reaches EVERY socket in the
      // room, including the one that POSTed this very bootstrap — so the
      // browser that just won the claim race receives its own broadcast back.
      // Its own bootstrap POST already ran the (guarded) full-list replace via
      // `hydratedOnce`; re-running it here unconditionally would risk wiping a
      // workspace this browser created in the narrow window between that POST
      // resolving and this broadcast arriving. Only apply it if this browser
      // hasn't hydrated yet (e.g. it's a DIFFERENT browser that joined the
      // socket room before its own GET/bootstrap round trip completed).
      if (hydratedOnce.current) return;
      hydratedOnce.current = true;
      hydrateFromServer(mid, payload.workspaces);
    };

    socket.on('machine-workspace:created', onCreated);
    socket.on('machine-workspace:updated', onUpdated);
    socket.on('machine-workspace:deleted', onDeleted);
    socket.on('machine-workspace:bootstrapped', onBootstrapped);
    return () => {
      socket.off('machine-workspace:created', onCreated);
      socket.off('machine-workspace:updated', onUpdated);
      socket.off('machine-workspace:deleted', onDeleted);
      socket.off('machine-workspace:bootstrapped', onBootstrapped);
    };
  }, [socket, machineId, applyServerUpsert, applyServerDelete, hydrateFromServer]);
}

interface CreateWorkspaceResponse {
  created: boolean;
  workspace: ServerWorkspaceDTO;
}

async function pushNewWorkspace(machineId: string, workspaceId: string): Promise<void> {
  const workspace = useMachineWorkspaceStore.getState().machines[machineId]?.workspaces[workspaceId];
  if (!workspace) return;
  await post<CreateWorkspaceResponse>('/api/machines/workspaces', {
    machineId,
    id: workspace.id,
    name: workspace.name,
    scope: workspace.scope,
    columns: toWireColumns(workspace.columns),
  })
    .then((res) => {
      // Lost the first-writer-wins race (another browser materialized the
      // same client-derived id first, e.g. two tabs opening the same session)
      // — the API's contract is that the loser adopts the winner's row, not
      // its own payload. Without this, this browser would keep showing its
      // own diverged local layout forever instead of the shared canonical one.
      if (!res.created) useMachineWorkspaceStore.getState().applyServerUpsert(machineId, res.workspace);
    })
    .catch(() => {});
}

/** Which of this workspace's server-visible fields a given local action actually
 * changed — {@link pushWorkspaceUpdate} sends only these, so a PATCH racing a
 * DIFFERENT browser's concurrent edit to the OTHER field can't clobber it with
 * a stale copy (see that function's doc for the concrete two-browser scenario). */
type ChangedFields = { name?: true; columns?: true };

/** For a workspace that MIGHT already exist server-side (any layout/rename change
 * after creation): PATCH first, falling back to POST-create on a 404 — a brand
 * new workspace materialized via `openTerminal`'s "existing session, new pane"
 * branch has never gone through `createWorkspace`'s own POST.
 *
 * `changed` restricts the PATCH body to the field(s) this specific action
 * touched. The route (and `updateWorkspace`) already support a true partial
 * update — name-only, columns-only, or both — precisely so this can avoid
 * sending the field it did NOT touch: if it always sent both, a rename in one
 * browser racing a pane split in another (each reading its OWN possibly-stale
 * copy of the field it didn't mean to change) would have the later PATCH
 * silently revert the earlier one's change.
 *
 * Calls `fetchWithAuth` directly (rather than the higher-level `patch()`
 * helper) specifically to read the real HTTP status code: `patch()`/`post()`
 * go through `fetchJSON`, which throws a plain `Error` with no status
 * attached, so branching on `error.message === 'not_found'` would couple this
 * to the exact JSON body shape `{error: 'not_found'}` and `fetchJSON`'s
 * `json.error || json.message || text` construction — fragile to either
 * changing out from under this call site. A raw 404 status check has no such
 * coupling. */
async function pushWorkspaceUpdate(machineId: string, workspaceId: string, changed: ChangedFields): Promise<void> {
  const workspace = useMachineWorkspaceStore.getState().machines[machineId]?.workspaces[workspaceId];
  if (!workspace) return;
  const columns = toWireColumns(workspace.columns);

  try {
    const response = await fetchWithAuth('/api/machines/workspaces', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machineId,
        workspaceId,
        ...(changed.name ? { name: workspace.name } : {}),
        ...(changed.columns ? { columns } : {}),
      }),
    });
    if (response.ok) return;
    if (response.status !== 404) return;
    // Not found server-side yet — create it. This IS a brand-new row, so the
    // full current snapshot is sent regardless of `changed` — there is no
    // narrower "what changed" for a row that doesn't exist yet.
  } catch {
    // Network failure or similar — swallow. The local grid already reflects
    // the user's action, and the next successful push (this browser's own,
    // or a broadcast from elsewhere) reconciles the server.
    return;
  }

  await post('/api/machines/workspaces', {
    machineId,
    id: workspace.id,
    name: workspace.name,
    scope: workspace.scope,
    columns,
  }).catch(() => {});
}

function pushRemoval(machineId: string, workspaceId: string): void {
  del(
    `/api/machines/workspaces?machineId=${encodeURIComponent(machineId)}&workspaceId=${encodeURIComponent(workspaceId)}`
  ).catch(() => {});
}

/**
 * Server-pushing wrappers around the workspace store's identity/layout
 * actions: call the real local action first (unchanged, instant), then push
 * the affected workspace's resulting state to the server. `createWorkspace`
 * knows its workspace is brand new (a fresh local id) and POSTs directly;
 * every other action might be touching a workspace that already exists
 * server-side OR doesn't yet (e.g. `openTerminal` materializing a new one),
 * so those PATCH first and fall back to POST-create on a 404. That fallback
 * (rather than a client-tracked "known server ids" set) is what lets this be
 * called independently from more than one component with no shared state to
 * keep in sync.
 *
 * Actions that stay purely local, not wrapped here: `setActiveWorkspace`,
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

  return useMemo(() => ({
    createWorkspace(scope?: MachineNodeScope): string {
      const id = createWorkspaceLocal(machineId, scope);
      void pushNewWorkspace(machineId, id);
      return id;
    },
    removeWorkspace(workspaceId: string): void {
      removeWorkspaceLocal(machineId, workspaceId);
      pushRemoval(machineId, workspaceId);
    },
    renameWorkspace(workspaceId: string, name: string): void {
      renameWorkspaceLocal(machineId, workspaceId, name);
      void pushWorkspaceUpdate(machineId, workspaceId, { name: true });
    },
    splitRight(workspaceId: string, fromPaneId: string): void {
      splitRightLocal(machineId, workspaceId, fromPaneId);
      void pushWorkspaceUpdate(machineId, workspaceId, { columns: true });
    },
    splitDown(workspaceId: string, fromPaneId: string): void {
      splitDownLocal(machineId, workspaceId, fromPaneId);
      void pushWorkspaceUpdate(machineId, workspaceId, { columns: true });
    },
    closePane(workspaceId: string, paneId: string): void {
      closePaneLocal(machineId, workspaceId, paneId);
      void pushWorkspaceUpdate(machineId, workspaceId, { columns: true });
    },
    /** Closes several panes of the SAME workspace as one push, not one PATCH per
     * pane — e.g. emptying every running pane when removing the machine's only
     * remaining workspace. `closePane` in a loop would fire N independent
     * fire-and-forget PATCHes with no ordering guarantee: a slower EARLIER
     * request resolving after a later one could leave the server's layout at
     * an intermediate (still-bound-to-a-just-killed-agent) state instead of
     * the final fully-emptied one. Applying every local close first, then
     * pushing once, means the single PATCH always carries the final result. */
    closePanes(workspaceId: string, paneIds: string[]): void {
      paneIds.forEach((paneId) => closePaneLocal(machineId, workspaceId, paneId));
      if (paneIds.length > 0) void pushWorkspaceUpdate(machineId, workspaceId, { columns: true });
    },
    bindPaneTerminal(workspaceId: string, paneId: string, scope: OpenTerminalScope, pendingPrompt?: string): boolean {
      const bound = bindPaneTerminalLocal(machineId, workspaceId, paneId, scope, pendingPrompt);
      if (bound) void pushWorkspaceUpdate(machineId, workspaceId, { columns: true });
      return bound;
    },
    /** `openTerminal` can materialize a new workspace, relocate an existing
     * one to front, or land in one already showing the session — push
     * whichever workspace it actually affected, resolved the same way the
     * local action itself resolves "where does this session live". */
    openTerminal(scope: OpenTerminalScope): void {
      openTerminalLocal(machineId, scope);
      const machine = useMachineWorkspaceStore.getState().machines[machineId];
      if (!machine) return;
      const home = workspaceShowing(machine, scope) ?? machine.workspaces[sessionWorkspaceId(scope)];
      if (home) void pushWorkspaceUpdate(machineId, home.id, { columns: true });
    },
  }), [
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
