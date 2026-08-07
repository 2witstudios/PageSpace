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
 * **Rows are the only source.** `agent_sessions.workspaceState` (the legacy
 * jsonb blob) was dropped at Phase 3's contract step, along with its PUT and
 * the blob→rows reconcile — there is nothing left to dual-write and nothing
 * left to drift. Everything the rows deliberately do NOT own is derived
 * here, on the way out: pane LABELS by joining the conversation/shell/page
 * title at read time (`labelGrid`), and focus not at all (it is client-local
 * per #2048).
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

/** What the critical section decides, before labels are joined on the way out. */
type VerbOutcomeRows =
  | { status: 'ok'; rev: number; rows: LayoutGridColumn[]; applied: boolean }
  | { status: 'stale'; rev: number; rows: LayoutGridColumn[] };

export async function applyWorkspaceLayoutVerb(input: {
  workspaceId: string;
  opId: string;
  baseRev: number;
  verb: WorkspaceLayoutVerb;
}): Promise<ApplyWorkspaceLayoutVerbResult> {
  const { workspaceId, opId, baseRev, verb } = input;

  const outcome = await withWorkspaceLayoutLock(workspaceId, async (tx): Promise<VerbOutcomeRows> => {
    const store = await createDbWorkspaceLayoutStore(tx);

    const [grid, rev] = await Promise.all([store.getWorkspaceGrid(workspaceId), store.currentRev(workspaceId)]);
    const state = workspaceStateFromGrid({ workspaceId, grid });

    // Replay check FIRST: an op that already landed must answer success (with
    // current truth), never 409 — the retry's whole point is that its effect
    // is already part of the rev the client will observe.
    const replayed = await store.findOp(workspaceId, opId);
    if (replayed) {
      return { status: 'ok', rev, rows: grid, applied: false };
    }

    if (baseRev !== rev) {
      return { status: 'stale', rev, rows: grid };
    }

    const reduced = applyVerbLocal(state, workspaceId, verb);
    if (!reduced.applied || reduced.state === null) {
      await store.recordOp({ workspaceId, opId, rev, applied: false });
      return { status: 'ok', rev, rows: grid, applied: false };
    }

    const next = gridFromWorkspaceState(reduced.state);
    const written = await store.replaceWorkspaceGrid({ workspaceId, grid: next });
    await store.recordOp({ workspaceId, opId, rev: written.rev, applied: written.applied });
    return { status: 'ok', rev: written.rev, rows: next, applied: written.applied };
  });

  // Labels join OUTSIDE the lock: they are derived display data, so a racing
  // rename just means this response carries the title from a moment ago —
  // never a reason to hold the per-workspace serializing lock over more IO.
  const grid = await labelGrid(outcome.rows);

  if (outcome.status === 'stale') return { status: 'stale', rev: outcome.rev, grid };

  if (outcome.applied) {
    broadcastWorkspaceUpdated({ workspaceId, rev: outcome.rev, verb: verb.type, opId, grid });
  }
  return { status: 'ok', rev: outcome.rev, grid, applied: outcome.applied };
}

export interface WorkspaceLayoutSnapshot {
  rev: number;
  /** `null` when the session has no grid at all (no pane rows). */
  grid: WorkspaceLayoutGridDTO | null;
}

/**
 * Turn persisted rows into the wire grid, joining every bound pane's display
 * label at READ time — the conversation title, the shell name, the page
 * title, and the conversation's own `contextId` as `agentPageId`. This is
 * the whole reason rows carry no `name`: a renamed conversation can never
 * leave a stale pane label behind (the drift class the dead blob carried).
 */
async function labelGrid(grid: LayoutGridColumn[]): Promise<WorkspaceLayoutGridDTO> {
  if (grid.length === 0) return [];
  const labels = await resolvePaneLabels(grid);
  return applyPaneLabels(grid, labels);
}

/** The pure half of {@link labelGrid} — rows + resolved labels → the wire grid. */
function applyPaneLabels(grid: LayoutGridColumn[], labels: Map<string, PaneLabel>): WorkspaceLayoutGridDTO {
  // Fractions come straight off the rows (issue #2208) — unlike labels there
  // is nothing to re-derive, and unlike focus they are not client-local. An
  // unsized container carries no key, matching what the reducer produces.
  return grid.map((column) => ({
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
  }));
}

/**
 * The layout GET's rev-carrying snapshot: the labelled grid derived from the
 * relational rows, `null` when the session has no rows. Read-only and
 * lock-free: a racing verb just means the snapshot is one rev behind, which
 * the rev itself reports.
 */
export async function readWorkspaceLayoutSnapshot(workspaceId: string): Promise<WorkspaceLayoutSnapshot> {
  const store = await createDbWorkspaceLayoutStore();
  const [grid, rev] = await Promise.all([store.getWorkspaceGrid(workspaceId), store.currentRev(workspaceId)]);
  if (grid.length === 0) return { rev, grid: null };
  return { rev, grid: await labelGrid(grid) };
}

/**
 * MANY sessions' labelled grids in one pass — the sessions-list GET's shape
 * (polled by every open sidebar, so the per-session read this replaced was
 * 2N queries a tick). Two row queries and ONE label resolution across every
 * session's panes together; a session with no rows simply has no entry.
 */
export async function readWorkspaceGridsBulk(
  workspaceIds: string[],
): Promise<Map<string, WorkspaceLayoutGridDTO>> {
  const labelled = new Map<string, WorkspaceLayoutGridDTO>();
  if (workspaceIds.length === 0) return labelled;

  const store = await createDbWorkspaceLayoutStore();
  const grids = await store.getWorkspaceGridsBulk(workspaceIds);
  if (grids.size === 0) return labelled;

  const labels = await resolvePaneLabels([...grids.values()].flat());
  for (const [workspaceId, grid] of grids) {
    labelled.set(workspaceId, applyPaneLabels(grid, labels));
  }
  return labelled;
}

/**
 * The sessions-list wire shape, rebuilt from rows. The list has always served
 * a whole `PersistedWorkspaceState` (once the blob, now this), and old
 * clients still read it that way, so the shape is preserved exactly — but the
 * two view-state fields have no server-side owner any more: focus is
 * client-local (#2048), so `activePaneId` is a well-formed DEFAULT (the first
 * pane) rather than a restored fact, and nothing is ever pending-picker on a
 * read. `null` for a session with no grid, exactly as before.
 */
export function workspaceListEntryFromGrid(
  workspaceId: string,
  grid: WorkspaceLayoutGridDTO | null,
): PersistedWorkspaceState | null {
  const firstPaneId = grid?.find((column) => column.panes.length > 0)?.panes[0].id;
  if (!grid || firstPaneId === undefined) return null;
  return { id: workspaceId, columns: grid, activePaneId: firstPaneId, pendingPickerPaneId: null };
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
