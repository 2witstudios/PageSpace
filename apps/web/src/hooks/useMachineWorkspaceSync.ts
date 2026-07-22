'use client';

/**
 * Server-authoritative sync for a Machine's workspace list (#2048) — the
 * successor to PR #2031's `localStorage`-only `useMachineWorkspaceStore`.
 *
 * Two exports, split because they have different mount-cardinality needs:
 *
 * - {@link useMachineWorkspaceSync} owns the stateful side effects (SWR fetch,
 *   the one-time bootstrap race, the socket subscription). It is mounted MORE
 *   THAN ONCE for the machine the user has open: `DevelopmentSidebar` mounts
 *   one instance per machine ROW (so an expanded row renders live workspaces
 *   without ever visiting the machine), and `MachineView` mounts one for the
 *   open machine — the true per-machine root that survives Terminal-tab
 *   unmount/remount (Radix `TabsContent` unmounts inactive tabs; `MachineView`
 *   doesn't). Dual mount is DESIGNED FOR, not tolerated: the bootstrap claim
 *   is resolved server-side by the claim table, and the "nothing to migrate"
 *   decision is shared across instances by the module-level
 *   {@link declinedBootstraps} precisely because instances see each other's
 *   writes through the one shared store.
 * - {@link useSyncedWorkspaceActions} has no internal state to coordinate (see
 *   its own doc for why), so it's safe to call from every component that
 *   mutates a workspace — `WorkspaceLeaves` (sidebar) and `TerminalPanes`
 *   (pane grid) each call it independently.
 *
 * Two races remain, both ACCEPTED (each is a lost view of a row, never lost
 * server state — the server row survives in both):
 *
 * 1. A stale full-replace hydrate landing AFTER a workspace's bound `created`
 *    echo can still drop a just-created workspace: `hydratedOnce` is
 *    per-instance, so a second instance whose GET predates the create replaces
 *    the list from a payload that never contained it. No later event
 *    reintroduces it (`updated` skips unknown workspaces — see below); a
 *    reload or remount does. The real fix is per-machine, cross-instance
 *    hydration state (the shape `declinedBootstraps` already has), tracked as
 *    a follow-up.
 * 2. A `machine-workspace:created` missed while the socket was disconnected
 *    leaves this browser without that workspace until the next full hydrate —
 *    see `onUpdated`'s doc for why an `updated` event can't introduce one.
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
  nodeScopeNames,
  type MachineNodeScope,
  type OpenTerminalScope,
  type ServerColumnDTO,
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

/**
 * Machines where this browser session already decided "nothing local to
 * migrate — claim nothing" (the empty-payload branch below). MODULE-level, not
 * a per-instance ref, because this hook is mounted more than once for the same
 * machine (`DevelopmentSidebar` mounts it per machine row AND `MachineView`
 * mounts it for the open machine) and the instances share one store: on an
 * unbootstrapped machine whose server list is non-empty, instance 1's
 * empty-payload hydrate writes the server's rows INTO the store, so instance
 * 2's effect would then read a non-empty local list and POST a bootstrap claim
 * that merely echoes the server's own rows back at it — burning the
 * first-writer-wins claim on nothing, which permanently forecloses a legacy
 * browser's real un-migrated history. Exactly what the empty-payload guard
 * exists to prevent, so the decision has to be visible across instances.
 */
const declinedBootstraps = new Set<string>();

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

  // Records that this browser has made its one bootstrap decision for this
  // machine — either it POSTed a claim, or it had nothing local to migrate and
  // deliberately declined to (the empty-payload branch below). Guards against
  // re-deciding on every SWR revalidation — not against the cross-browser
  // race, which the server's claim table (not this ref) resolves.
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
  // because no instance is ever reused across machineIds: `MachineView` is kept
  // by `MachineKeepAliveHost` as one distinct component instance per machine,
  // and `DevelopmentSidebar`'s instances are one per machine row.
  //
  // It is per-INSTANCE, though, and the machine the user has open has two
  // instances (sidebar row + `MachineView` — see this module's doc). Each
  // hydrates once from its own GET, so a second instance's stale full-replace
  // can still land after the first has applied a `created` echo and drop that
  // workspace locally. That is residual race (1) in the module doc: accepted,
  // server row intact, recovered by a reload; the fix is cross-instance
  // hydration state, not a second per-instance ref.
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

    const local = useMachineWorkspaceStore.getState().machines[machineId];
    const payload = (local ? workspacesOf(local) : []).map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      scope: nodeScopeNames(workspace.scope),
      columns: toWireColumns(workspace.columns),
    }));

    // Nothing local to seed — so claim nothing. Bootstrap is first-writer-wins
    // (one row per machine, PK machineId): claiming with an empty list would
    // burn the claim and permanently discard the un-migrated history of a
    // browser that DOES have some. This matters now that `ensureMachine` no
    // longer fabricates a Workspace 1: the Development sidebar mounts this hook
    // per machine row, so merely rendering it would otherwise fire an empty
    // claim at every machine in the drive before the user opens any of them.
    //
    // Must HYDRATE, not just skip the POST: the hydrate above is gated on
    // `data.bootstrapped`, so returning without one would leave this browser
    // showing an empty machine while the server holds real rows.
    //
    // And the hydrate must stay PROVISIONAL — it marks the bootstrap decision
    // (`bootstrapAttempted`: nothing to migrate, ever), NOT `hydratedOnce`.
    // Not claiming means another browser WITH history can still win the claim
    // later, and its seeded list arrives only as a
    // `machine-workspace:bootstrapped` broadcast — which `onBootstrapped`
    // ignores once `hydratedOnce` is set. Marking this hydrate final would
    // strand this browser on the unclaimed (usually empty) list until remount.
    // Leaving `hydratedOnce` unset here is safe: this branch only runs when the
    // local list is empty, so the full-list replace cannot wipe anything, and a
    // later `bootstrapped: true` revalidation (a missed broadcast) re-enters
    // the hydrate above instead of being gated out.
    if (payload.length === 0 || declinedBootstraps.has(machineId)) {
      bootstrapAttempted.current = true;
      // Only the FIRST decliner applies the provisional hydrate. A later
      // instance (or a later effect run) re-applying it with SWR's possibly
      // STALE cached list would full-replace away workspaces that arrived over
      // the socket since — the store is already current; leave it alone.
      if (!declinedBootstraps.has(machineId)) {
        declinedBootstraps.add(machineId);
        hydrateFromServer(machineId, data.workspaces);
      }
      return;
    }

    bootstrapAttempted.current = true;

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
      // As they arrive: a client still running the pre-narrowing code sends
      // panes carrying their own checkout. `applyServerUpsert` projects.
      columns?: ServerColumnDTO[];
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
    scope: nodeScopeNames(workspace.scope),
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
    scope: nodeScopeNames(workspace.scope),
    columns,
  }).catch(() => {});
}

/** Fire-and-forget DELETE with bounded retries. Removal is optimistic like
 * every other push here (the local grid already updated), but unlike a layout
 * PATCH there is no "next push" to reconcile a transient failure — so this IS
 * the reconciliation. If every attempt fails, the server row survives and the
 * next full hydrate resurrects the row locally: visible and annoying, but
 * recoverable (remove it again) — whereas rolling the local removal back would
 * restore a grid whose PTYs were already killed, a strictly worse dead-pane
 * state. Each retry first checks the workspace is STILL locally removed:
 * session-derived workspace ids are deterministic (`sessionWorkspaceId`), so
 * the user re-opening that session re-materializes the SAME id, and a stale
 * retry would delete the new incarnation out from under them. A 404 also lands
 * in the catch (`del()` hides the status) when another browser already removed
 * the row — the capped retries just expire against it harmlessly. */
function pushRemoval(machineId: string, workspaceId: string, attempt = 0): void {
  del(
    `/api/machines/workspaces?machineId=${encodeURIComponent(machineId)}&workspaceId=${encodeURIComponent(workspaceId)}`
  ).catch(() => {
    if (attempt >= 2) return;
    setTimeout(() => {
      const revived = useMachineWorkspaceStore.getState().machines[machineId]?.workspaces[workspaceId];
      if (!revived) pushRemoval(machineId, workspaceId, attempt + 1);
    }, 1500 * (attempt + 1));
  });
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
    /** Closing the last pane removes the whole workspace, and that case must
     * DELETE, not PATCH: `pushWorkspaceUpdate` falls back to POST-create on a
     * 404, so PATCHing a workspace this very call just removed would RE-CREATE
     * it server-side and broadcast the resurrected row back to every browser —
     * including the one whose user just closed it. */
    closePane(workspaceId: string, paneId: string): void {
      const removedWorkspace = closePaneLocal(machineId, workspaceId, paneId);
      if (removedWorkspace) pushRemoval(machineId, workspaceId);
      else void pushWorkspaceUpdate(machineId, workspaceId, { columns: true });
    },
    bindPaneTerminal(workspaceId: string, paneId: string, scope: OpenTerminalScope, pendingPrompt?: string): boolean {
      const bound = bindPaneTerminalLocal(machineId, workspaceId, paneId, scope, pendingPrompt);
      if (bound) void pushWorkspaceUpdate(machineId, workspaceId, { columns: true });
      return bound;
    },
    /** `openTerminal` can materialize a new workspace, relocate an existing
     * one to front, or land in one already showing the session — push
     * whichever workspace it actually affected, resolved the same way the
     * local action itself resolves "where does this session live".
     *
     * RETURNS that workspace's id, because the caller cannot derive it: a
     * session another workspace is already showing lands THERE
     * (`workspaceShowing`), not in its own `sessionWorkspaceId` workspace —
     * a spawn that assumed the derived id would navigate to a workspace that
     * doesn't contain the session, or doesn't exist. `undefined` only when
     * the machine itself is missing (nothing was opened). */
    openTerminal(scope: OpenTerminalScope): string | undefined {
      openTerminalLocal(machineId, scope);
      const machine = useMachineWorkspaceStore.getState().machines[machineId];
      if (!machine) return undefined;
      const home = workspaceShowing(machine, scope) ?? machine.workspaces[sessionWorkspaceId(scope)];
      if (home) void pushWorkspaceUpdate(machineId, home.id, { columns: true });
      return home?.id;
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
