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
import { fetchWithAuth, post, patch, del } from '@/lib/auth/auth-fetch';
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
 */
export function useMachineWorkspaceSync(machineId: string): void {
  const ensureMachine = useMachineWorkspaceStore((state) => state.ensureMachine);
  const hydrateFromServer = useMachineWorkspaceStore((state) => state.hydrateFromServer);
  const applyServerUpsert = useMachineWorkspaceStore((state) => state.applyServerUpsert);
  const applyServerDelete = useMachineWorkspaceStore((state) => state.applyServerDelete);

  const socket = useSocket();
  usePageSocketRoom(machineId);

  // Guards against retrying the bootstrap POST on every SWR revalidation once
  // this browser has already tried it for this machine — not against the
  // cross-browser race, which the server's claim table (not this ref) resolves.
  const bootstrapAttempted = useRef(false);

  useEffect(() => {
    ensureMachine(machineId);
  }, [machineId, ensureMachine]);

  const key = `/api/machines/workspaces?machineId=${encodeURIComponent(machineId)}`;
  const { data } = useSWR<WorkspaceListResponse>(key, fetcher, { revalidateOnFocus: false });

  useEffect(() => {
    if (!data) return;

    if (data.bootstrapped) {
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
      .then((res) => hydrateFromServer(machineId, res.workspaces))
      .catch(() => {
        // Retry on the next data change (e.g. a manual refresh) rather than
        // leaving this machine permanently un-bootstrapped over a transient failure.
        bootstrapAttempted.current = false;
      });
  }, [machineId, data, hydrateFromServer]);

  useEffect(() => {
    if (!socket) return;

    const onCreated = (payload: ServerWorkspaceDTO & { machineId: string }) => {
      if (payload.machineId !== machineId) return;
      applyServerUpsert(machineId, payload);
    };
    const onUpdated = (payload: {
      machineId: string;
      workspaceId: string;
      name?: string;
      columns?: TerminalColumnState[];
    }) => {
      if (payload.machineId !== machineId) return;
      // `updated` only carries whichever of name/columns actually changed —
      // fill in the rest from what this browser already has for it.
      const current = useMachineWorkspaceStore.getState().machines[machineId]?.workspaces[payload.workspaceId];
      applyServerUpsert(machineId, {
        id: payload.workspaceId,
        name: payload.name ?? current?.name ?? '',
        scope: current?.scope ?? {},
        columns: payload.columns ?? current?.columns ?? [],
      });
    };
    const onDeleted = (payload: { machineId: string; workspaceId: string }) => {
      if (payload.machineId !== machineId) return;
      applyServerDelete(machineId, payload.workspaceId);
    };
    const onBootstrapped = (payload: { machineId: string; workspaces: ServerWorkspaceDTO[] }) => {
      if (payload.machineId !== machineId) return;
      hydrateFromServer(machineId, payload.workspaces);
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

async function pushNewWorkspace(machineId: string, workspaceId: string): Promise<void> {
  const workspace = useMachineWorkspaceStore.getState().machines[machineId]?.workspaces[workspaceId];
  if (!workspace) return;
  await post('/api/machines/workspaces', {
    machineId,
    id: workspace.id,
    name: workspace.name,
    scope: workspace.scope,
    columns: toWireColumns(workspace.columns),
  }).catch(() => {});
}

/** For a workspace that MIGHT already exist server-side (any layout/rename change
 * after creation): PATCH first, falling back to POST-create on a 404 — a brand
 * new workspace materialized via `openTerminal`'s "existing session, new pane"
 * branch has never gone through `createWorkspace`'s own POST. */
async function pushWorkspaceUpdate(machineId: string, workspaceId: string): Promise<void> {
  const workspace = useMachineWorkspaceStore.getState().machines[machineId]?.workspaces[workspaceId];
  if (!workspace) return;
  const columns = toWireColumns(workspace.columns);

  try {
    await patch('/api/machines/workspaces', { machineId, workspaceId, name: workspace.name, columns });
  } catch (error) {
    // Not found server-side yet — create it. `updateWorkspace`'s route returns
    // `{error: 'not_found', reason: 'not_found'}` on a 404, which `auth-fetch.ts`
    // surfaces as an Error whose message IS that reason string. Any OTHER
    // failure (network blip, 500) is swallowed here: the local grid already
    // reflects the user's action, and the next successful push (this browser's
    // own, or a broadcast from elsewhere) reconciles the server.
    if (!(error instanceof Error) || error.message !== 'not_found') return;
    await post('/api/machines/workspaces', {
      machineId,
      id: workspace.id,
      name: workspace.name,
      scope: workspace.scope,
      columns,
    }).catch(() => {});
  }
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
      void pushWorkspaceUpdate(machineId, workspaceId);
    },
    splitRight(workspaceId: string, fromPaneId: string): void {
      splitRightLocal(machineId, workspaceId, fromPaneId);
      void pushWorkspaceUpdate(machineId, workspaceId);
    },
    splitDown(workspaceId: string, fromPaneId: string): void {
      splitDownLocal(machineId, workspaceId, fromPaneId);
      void pushWorkspaceUpdate(machineId, workspaceId);
    },
    closePane(workspaceId: string, paneId: string): void {
      closePaneLocal(machineId, workspaceId, paneId);
      void pushWorkspaceUpdate(machineId, workspaceId);
    },
    bindPaneTerminal(workspaceId: string, paneId: string, scope: OpenTerminalScope, pendingPrompt?: string): boolean {
      const bound = bindPaneTerminalLocal(machineId, workspaceId, paneId, scope, pendingPrompt);
      if (bound) void pushWorkspaceUpdate(machineId, workspaceId);
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
      if (home) void pushWorkspaceUpdate(machineId, home.id);
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
