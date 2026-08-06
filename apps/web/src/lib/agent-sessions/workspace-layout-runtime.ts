/**
 * Agent workspace layout — production wiring (epic Phase 3, the #2202
 * machine-panes pattern re-cut for sessions).
 *
 * `applyWorkspaceLayoutVerb` is the SINGLE write path for every pane-grid
 * mutation arriving as a verb: it holds the per-workspace advisory lock
 * (`withWorkspaceLayoutLock`) for the ENTIRE read-reduce-write cycle, runs
 * the shared pure reducer (`applyVerbLocal`,
 * `@pagespace/lib/agent-sessions/workspace-layout-verbs` — the SAME function
 * the client's optimistic apply uses), and persists through the store's one
 * write primitive, whose content diff is the AUTHORITATIVE "did anything
 * actually change" signal (it decides rev bumps and broadcasts; the
 * reducer's structural `applied` flag only knows whether the target
 * resolved).
 *
 * **Dual-write window.** `agent_sessions.workspaceState` (the legacy blob)
 * is kept true on every applied verb — the store re-serializes the reduced
 * state into the column in the same transaction as the row write — and the
 * legacy PUT (`saveWorkspaceBlobReconciled`) conversely applies blob→rows
 * through the SAME projection (`gridFromWorkspaceState`), under the SAME
 * lock. Either writer keeps both representations true; the drift-guard
 * property test in packages/lib pins the projection pair. The blob and this
 * reconcile die together in a later contract PR.
 *
 * **Idempotency.** Every verb POST carries a client-minted `opId`; a replay
 * (client timeout, duplicate delivery) finds its `(workspaceId, opId)`
 * memory row and short-circuits to the CURRENT truth instead of re-applying
 * — which matters because a replayed `split_right` would re-insert its
 * already-inserted client-minted pane id and violate the compound PK.
 *
 * **Concurrency.** A stale `baseRev` answers `status: 'stale'` with the
 * current rev + grid — truth to rebase against (the route maps it to 409).
 *
 * Access control is NOT this module's job — the verbs route runs
 * `checkSessionAccess` first, same as every other session-scoped route.
 */

import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import { agentSessionShells } from '@pagespace/db/schema/agent-sessions';
import { pages } from '@pagespace/db/schema/core';
import {
  applyVerbLocal,
  gridFromWorkspaceState,
  workspaceStateFromGrid,
  type LayoutGridColumn,
  type WorkspaceLayoutGridDTO,
  type WorkspaceLayoutVerb,
  type WorkspaceState,
} from '@pagespace/lib/agent-sessions/workspace-layout-verbs';
import {
  createDbWorkspaceLayoutStore,
  withWorkspaceLayoutLock,
} from '@pagespace/lib/services/agent-sessions/workspace-layout-store';
import type { PaneScope, PersistedWorkspaceState } from '@pagespace/lib/agent-sessions/contract';
import { broadcastWorkspaceUpdated } from '@/lib/websocket/agent-workspace-events';

export type ApplyWorkspaceLayoutVerbResult =
  /** The op ran (or replayed, or no-oped). `applied` = the content diff's verdict. */
  | { status: 'ok'; rev: number; grid: WorkspaceLayoutGridDTO; applied: boolean }
  /** `baseRev` no longer names the current rev — here is the truth to rebase against. */
  | { status: 'stale'; rev: number; grid: WorkspaceLayoutGridDTO };

function gridDTO(state: WorkspaceState | null): WorkspaceLayoutGridDTO {
  return state?.columns ?? [];
}

export async function applyWorkspaceLayoutVerb(input: {
  workspaceId: string;
  opId: string;
  baseRev: number;
  verb: WorkspaceLayoutVerb;
}): Promise<ApplyWorkspaceLayoutVerbResult> {
  const { workspaceId, opId, baseRev, verb } = input;

  const result = await withWorkspaceLayoutLock(workspaceId, async (tx): Promise<ApplyWorkspaceLayoutVerbResult> => {
    const store = await createDbWorkspaceLayoutStore(tx);

    const [grid, blob, rev] = await Promise.all([
      store.getWorkspaceGrid(workspaceId),
      store.getWorkspaceBlob(workspaceId),
      store.currentRev(workspaceId),
    ]);
    const state = workspaceStateFromGrid({ workspaceId, grid, blob });

    // Replay check FIRST: an op that already landed must answer success (with
    // current truth), never 409 — the retry's whole point is that its effect
    // is already part of the rev the client will observe.
    const replayed = await store.findOp(workspaceId, opId);
    if (replayed) {
      return { status: 'ok', rev, grid: gridDTO(state), applied: false };
    }

    if (baseRev !== rev) {
      return { status: 'stale', rev, grid: gridDTO(state) };
    }

    const outcome = applyVerbLocal(state, workspaceId, verb);
    if (!outcome.applied || outcome.state === null) {
      await store.recordOp({ workspaceId, opId, rev, applied: false });
      return { status: 'ok', rev, grid: gridDTO(state), applied: false };
    }

    const written = await store.replaceWorkspaceGrid({
      workspaceId,
      grid: gridFromWorkspaceState(outcome.state),
      workspaceState: outcome.state,
    });
    await store.recordOp({ workspaceId, opId, rev: written.rev, applied: written.applied });
    return { status: 'ok', rev: written.rev, grid: gridDTO(outcome.state), applied: written.applied };
  });

  if (result.status === 'ok' && result.applied) {
    broadcastWorkspaceUpdated({ workspaceId, rev: result.rev, verb: verb.type, opId, grid: result.grid });
  }
  return result;
}

/**
 * The legacy PUT's write path during the dual-write window: persist the blob
 * exactly as before (unconditionally — it carries client-local view state
 * like `activePaneId` that the rows deliberately do not), AND reconcile the
 * relational rows from it through the same `gridFromWorkspaceState`
 * projection the verb path uses, under the same per-workspace lock — so a
 * blob writer and a verb writer can never interleave into disagreement.
 * Broadcasts `workspace:updated` iff the rows actually changed.
 */
export async function saveWorkspaceBlobReconciled(input: {
  workspaceId: string;
  workspace: PersistedWorkspaceState;
}): Promise<void> {
  const { workspaceId, workspace } = input;
  const result = await withWorkspaceLayoutLock(workspaceId, async (tx) => {
    const store = await createDbWorkspaceLayoutStore(tx);
    await store.saveWorkspaceBlob(workspaceId, workspace);
    return store.replaceWorkspaceGrid({ workspaceId, grid: gridFromWorkspaceState(workspace) });
  });
  if (result.applied) {
    broadcastWorkspaceUpdated({
      workspaceId,
      rev: result.rev,
      verb: 'legacy_replace',
      opId: null,
      grid: workspace.columns,
    });
  }
}

export interface WorkspaceLayoutSnapshot {
  rev: number;
  /** `null` when the session has no grid anywhere (no rows AND no blob). */
  grid: WorkspaceLayoutGridDTO | null;
}

/**
 * The layout GET's rev-carrying snapshot: grid derived from the relational
 * rows with display labels JOINed at read time — the conversation title, the
 * shell name, the page title, and the conversation's own `contextId` as
 * `agentPageId` — so a renamed conversation can never leave a stale pane
 * label behind (the drift class the blob carried). Falls back to the blob's
 * columns for a workspace whose rows are empty (never promoted / pre-deploy
 * writer); `null` when neither exists. Read-only and lock-free: a racing
 * verb just means the snapshot is one rev behind, which the rev itself
 * reports.
 */
export async function readWorkspaceLayoutSnapshot(workspaceId: string): Promise<WorkspaceLayoutSnapshot> {
  const store = await createDbWorkspaceLayoutStore();
  const [grid, blob, rev] = await Promise.all([
    store.getWorkspaceGrid(workspaceId),
    store.getWorkspaceBlob(workspaceId),
    store.currentRev(workspaceId),
  ]);

  if (grid.length === 0) {
    return { rev, grid: blob ? blob.columns : null };
  }

  const labels = await resolvePaneLabels(grid);
  return {
    rev,
    // Fractions come straight off the rows (issue #2208) — unlike labels there
    // is nothing to re-derive, and unlike focus they are not client-local. An
    // unsized container carries no key, matching what the reducer produces.
    grid: grid.map((column) => ({
      id: column.id,
      ...(column.widthFraction !== null ? { widthFraction: column.widthFraction } : {}),
      panes: column.panes.map((pane) => {
        const height = pane.heightFraction !== null ? { heightFraction: pane.heightFraction } : {};
        if (pane.kind === null) return { id: pane.id, scope: null, ...height };
        const label = pane.targetId !== null ? labels.get(`${pane.kind}:${pane.targetId}`) : undefined;
        const scope: PaneScope = {
          kind: pane.kind,
          targetId: pane.targetId,
          name: label?.name ?? '',
          agentPageId: label?.agentPageId ?? null,
        };
        return { id: pane.id, scope, ...height };
      }),
    })),
  };
}

interface PaneLabel {
  name: string;
  agentPageId: string | null;
}

/**
 * Bulk-resolve every bound pane's display label, one query per target kind
 * (grids are small; each list is a handful of ids). A target that no longer
 * exists simply resolves no label — the pane keeps its row and renders with
 * an empty name until the client repairs or rebinds it, exactly as the blob
 * behaved for deleted targets.
 */
async function resolvePaneLabels(grid: LayoutGridColumn[]): Promise<Map<string, PaneLabel>> {
  const targets = new Map<string, Set<string>>();
  for (const column of grid) {
    for (const pane of column.panes) {
      if (pane.kind === null || pane.targetId === null) continue;
      const set = targets.get(pane.kind) ?? new Set<string>();
      set.add(pane.targetId);
      targets.set(pane.kind, set);
    }
  }

  const labels = new Map<string, PaneLabel>();
  const chatIds = [...(targets.get('chat') ?? [])];
  const shellIds = [...(targets.get('terminal') ?? [])];
  const pageIds = [...(targets.get('page') ?? [])];

  const [chatRows, shellRows, pageRows] = await Promise.all([
    chatIds.length > 0
      ? db
          .select({ id: conversations.id, title: conversations.title, type: conversations.type, contextId: conversations.contextId })
          .from(conversations)
          .where(inArray(conversations.id, chatIds))
      : Promise.resolve([]),
    shellIds.length > 0
      ? db
          .select({ id: agentSessionShells.id, name: agentSessionShells.name })
          .from(agentSessionShells)
          .where(inArray(agentSessionShells.id, shellIds))
      : Promise.resolve([]),
    pageIds.length > 0
      ? db.select({ id: pages.id, title: pages.title }).from(pages).where(inArray(pages.id, pageIds))
      : Promise.resolve([]),
  ]);

  for (const row of chatRows) {
    labels.set(`chat:${row.id}`, {
      name: row.title ?? '',
      // Same derivation the session-conversation listings use: a page-agent
      // conversation's contextId IS its agent page id; global has none.
      agentPageId: row.type === 'page' ? row.contextId : null,
    });
  }
  for (const row of shellRows) labels.set(`terminal:${row.id}`, { name: row.name, agentPageId: null });
  for (const row of pageRows) labels.set(`page:${row.id}`, { name: row.title, agentPageId: null });

  return labels;
}
