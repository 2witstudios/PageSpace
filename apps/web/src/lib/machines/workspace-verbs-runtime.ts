/**
 * Machine Workspace Verbs — production wiring (#2202: entity promotion).
 *
 * `applyWorkspaceVerb` is the SINGLE write path for every workspace/pane
 * mutation: the human `POST /api/machines/workspaces/verbs` route and the AI
 * session tools (`session-tools-runtime.ts`, phase 3) both call this same
 * function, so the two writers the blob era needed to keep "byte-identical"
 * by convention are now structurally one writer.
 *
 * It loads just the ONE addressed workspace (metadata from
 * `machine_workspaces`, grid from `machine_pane_columns`/`machine_panes`),
 * runs the shared pure `applyVerbLocal` (see `workspace-verbs.ts`), and
 * persists the result:
 *   - a verb that removed the workspace deletes the `machine_workspaces` row
 *     (cascading its pane rows via FK) and bumps the machine's rev directly;
 *   - `rename-workspace` only touches metadata, so it bumps rev directly too
 *     (there is no grid change for `replaceWorkspaceGrid` to detect);
 *   - every other verb persists via `machine-panes-store.ts`'s
 *     `replaceWorkspaceGrid`, whose own content diff is the AUTHORITATIVE
 *     "did anything actually change" signal — overriding the pure reducer's
 *     structural `applied` flag, which only knows whether the target
 *     resolved, not whether the resulting bytes differ.
 *
 * `machine_workspaces.layout` is kept in sync as a best-effort MIRROR on
 * every grid-touching write, purely as a ROLLING-DEPLOY SHIM: an old server
 * instance still running the pre-#2202 code only ever reads/writes that
 * column, so keeping it current means its GETs stay correct during a deploy
 * window. Follow-up (see #2202's phase-5 sweep) drops the column and this
 * mirroring once no such instance can run.
 */

import {
  createWorkspace,
  updateWorkspace,
  removeWorkspace,
  type MachineWorkspacesDeps,
  type WorkspacePlanDenialReason,
} from '@pagespace/lib/services/machines/machine-workspaces';
import type { MachineWorkspaceRecord } from '@pagespace/lib/services/machines/machine-workspaces-store';
import { createDbMachinePanesStore, withMachineLock, type DbExecutor, type MachinePanesStore, type WorkspaceGridColumnRecord } from '@pagespace/lib/services/machines/machine-panes-store';
import { buildMachineWorkspacesDeps } from './machine-workspaces-runtime';
import { broadcastMachineWorkspaceEvent } from '@/lib/websocket';
import {
  applyVerbLocal,
  workspaceIdOf,
  type WorkspaceVerb,
} from '@/stores/machine-workspace/workspace-verbs';
import { machineNodeScope, nodeScopeNames, type MachineWorkspacesState, type WorkspaceState } from '@/stores/machine-workspace/workspace-reducer';
import { toWorkspaceScopeDTO, type WorkspaceScopeDTO } from './machine-workspaces-runtime';

export interface WorkspaceSnapshotDTO {
  id: string;
  name: string;
  scope: WorkspaceScopeDTO;
  columns: WorkspaceGridColumnRecord[];
  createdAt: string;
  updatedAt: string;
}

function toSnapshotDTO(record: MachineWorkspaceRecord, columns: WorkspaceGridColumnRecord[]): WorkspaceSnapshotDTO {
  return {
    id: record.id,
    name: record.name,
    scope: toWorkspaceScopeDTO(record),
    columns,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** A `MachineWorkspacesState` holding at most the ONE addressed workspace —
 * every verb targets exactly one, so there's no need to load a whole
 * machine's grids to apply one. `activePaneId`/`pendingPickerPaneId` are
 * local-only client concerns with no server meaning; they're set to
 * plumbing-only values `applyVerbLocal`'s transitions need but never read
 * back here. */
function toSingleWorkspaceState(record: MachineWorkspaceRecord | null, grid: WorkspaceGridColumnRecord[]): MachineWorkspacesState {
  if (!record) return { workspaces: {}, order: [], activeWorkspaceId: '' };
  const workspace: WorkspaceState = {
    id: record.id,
    name: record.name,
    scope: machineNodeScope({ projectName: record.projectName ?? undefined, branchName: record.branchName ?? undefined }),
    columns: grid,
    activePaneId: grid[0]?.panes[0]?.id ?? '',
    pendingPickerPaneId: null,
  };
  return { workspaces: { [record.id]: workspace }, order: [record.id], activeWorkspaceId: record.id };
}

export type ApplyWorkspaceVerbResult =
  | { ok: true; rev: number; workspaceId: string; workspace: WorkspaceSnapshotDTO | null; applied: boolean }
  | { ok: false; reason: WorkspacePlanDenialReason | 'not_found' };

export interface ApplyWorkspaceVerbDeps {
  workspacesDeps: MachineWorkspacesDeps;
  panesStore: MachinePanesStore;
  /** Only consulted for `create-workspace` — every other verb targets a
   * workspace that (if it exists) already has an owner. */
  ownerId: string;
}

function isSessionRef(value: unknown): value is { name: string; kind?: 'terminal' | 'chat' } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { name?: unknown; kind?: unknown };
  if (typeof candidate.name !== 'string' || candidate.name.length === 0) return false;
  return candidate.kind === undefined || candidate.kind === 'terminal' || candidate.kind === 'chat';
}

function requireString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Pure parse/validate of a `POST /api/machines/workspaces/verbs` body into a
 * {@link WorkspaceVerb} — no I/O, so it's testable without a store or DB.
 * Mirrors `scopeFromBody`'s leniency for the create-workspace `scope` field.
 */
export function parseWorkspaceVerb(body: unknown): { ok: true; verb: WorkspaceVerb } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'verb body must be an object' };
  const candidate = body as Record<string, unknown>;
  const fail = (error: string) => ({ ok: false as const, error });

  if (!requireString(candidate.workspaceId)) return fail('workspaceId is required');
  const workspaceId = candidate.workspaceId;

  switch (candidate.type) {
    case 'create-workspace': {
      if (!requireString(candidate.name)) return fail('name is required');
      if (!requireString(candidate.firstPaneId)) return fail('firstPaneId is required');
      const session = candidate.session;
      if (session !== null && session !== undefined && !isSessionRef(session)) return fail('session must be null or {name, kind?}');
      const scope = typeof candidate.scope === 'object' && candidate.scope !== null ? (candidate.scope as { projectName?: unknown; branchName?: unknown }) : {};
      return {
        ok: true,
        verb: {
          type: 'create-workspace',
          workspaceId,
          name: candidate.name,
          firstPaneId: candidate.firstPaneId,
          session: session ?? null,
          scope: {
            ...(typeof scope.projectName === 'string' && scope.projectName.length > 0 ? { projectName: scope.projectName } : {}),
            ...(typeof scope.branchName === 'string' && scope.branchName.length > 0 ? { branchName: scope.branchName } : {}),
          },
        },
      };
    }
    case 'rename-workspace': {
      if (!requireString(candidate.name)) return fail('name is required');
      return { ok: true, verb: { type: 'rename-workspace', workspaceId, name: candidate.name } };
    }
    case 'remove-workspace': {
      return { ok: true, verb: { type: 'remove-workspace', workspaceId } };
    }
    case 'split-pane': {
      if (!requireString(candidate.fromPaneId)) return fail('fromPaneId is required');
      if (!requireString(candidate.newPaneId)) return fail('newPaneId is required');
      if (candidate.direction !== 'right' && candidate.direction !== 'down') return fail('direction must be "right" or "down"');
      if (candidate.session !== undefined && !isSessionRef(candidate.session)) return fail('session must be {name, kind?}');
      if (candidate.newColumnId !== undefined && !requireString(candidate.newColumnId)) return fail('newColumnId must be a string');
      return {
        ok: true,
        verb: {
          type: 'split-pane',
          workspaceId,
          fromPaneId: candidate.fromPaneId,
          newPaneId: candidate.newPaneId,
          direction: candidate.direction,
          ...(candidate.newColumnId !== undefined ? { newColumnId: candidate.newColumnId as string } : {}),
          ...(candidate.session !== undefined ? { session: candidate.session } : {}),
        },
      };
    }
    case 'bind-pane': {
      if (!requireString(candidate.paneId)) return fail('paneId is required');
      if (!isSessionRef(candidate.session)) return fail('session is required and must be {name, kind?}');
      return { ok: true, verb: { type: 'bind-pane', workspaceId, paneId: candidate.paneId, session: candidate.session } };
    }
    case 'close-pane': {
      if (!requireString(candidate.paneId)) return fail('paneId is required');
      return { ok: true, verb: { type: 'close-pane', workspaceId, paneId: candidate.paneId } };
    }
    case 'add-pane': {
      if (!requireString(candidate.newPaneId)) return fail('newPaneId is required');
      if (!isSessionRef(candidate.session)) return fail('session is required and must be {name, kind?}');
      return { ok: true, verb: { type: 'add-pane', workspaceId, newPaneId: candidate.newPaneId, session: candidate.session } };
    }
    default:
      return fail('unknown verb type');
  }
}

export async function applyWorkspaceVerb(
  machineId: string,
  verb: WorkspaceVerb,
  deps: ApplyWorkspaceVerbDeps,
): Promise<ApplyWorkspaceVerbResult> {
  const workspaceId = workspaceIdOf(verb);
  const [existingRecord, grid] = await Promise.all([
    deps.workspacesDeps.store.findById(machineId, workspaceId),
    deps.panesStore.getWorkspaceGrid(machineId, workspaceId),
  ]);

  const outcome = applyVerbLocal(toSingleWorkspaceState(existingRecord, grid), verb);

  if (!outcome.applied) {
    const rev = await deps.panesStore.currentRev(machineId);
    return {
      ok: true,
      rev,
      workspaceId,
      applied: false,
      workspace: existingRecord ? toSnapshotDTO(existingRecord, grid) : null,
    };
  }

  const nextWorkspace = outcome.state.workspaces[workspaceId];

  if (!nextWorkspace) {
    // remove-workspace, or close-pane on the workspace's last pane: the row
    // (and its pane rows, via FK cascade) is gone.
    const removed = await removeWorkspace({ machineId, workspaceId, store: deps.workspacesDeps.store });
    if (!removed.ok) return removed;
    const rev = await deps.panesStore.bumpRev(machineId);
    return { ok: true, rev, workspaceId, applied: true, workspace: null };
  }

  if (verb.type === 'create-workspace') {
    const created = await createWorkspace({
      machineId,
      ownerId: deps.ownerId,
      id: workspaceId,
      name: nextWorkspace.name,
      scope: nodeScopeNames(nextWorkspace.scope),
      layout: { columns: nextWorkspace.columns },
      deps: deps.workspacesDeps,
    });
    if (!created.ok) return created;
    if (!created.created) {
      // Lost a first-writer-wins race at the DB level — adopt the winner's
      // row/grid rather than ours; this verb did not apply.
      const winnerGrid = await deps.panesStore.getWorkspaceGrid(machineId, workspaceId);
      const rev = await deps.panesStore.currentRev(machineId);
      return { ok: true, rev, workspaceId, applied: false, workspace: toSnapshotDTO(created.workspace, winnerGrid) };
    }
    const gridResult = await deps.panesStore.replaceWorkspaceGrid({ machineId, workspaceId, grid: nextWorkspace.columns });
    return {
      ok: true,
      rev: gridResult.rev,
      workspaceId,
      applied: gridResult.applied,
      workspace: toSnapshotDTO(created.workspace, nextWorkspace.columns),
    };
  }

  if (verb.type === 'rename-workspace') {
    const renamed = await updateWorkspace({ machineId, workspaceId, name: nextWorkspace.name, deps: deps.workspacesDeps });
    if (!renamed.ok) return renamed;
    const rev = await deps.panesStore.bumpRev(machineId);
    return { ok: true, rev, workspaceId, applied: true, workspace: toSnapshotDTO(renamed.workspace, nextWorkspace.columns) };
  }

  // split-pane / bind-pane / close-pane (non-last) / add-pane — grid-only changes.
  const gridResult = await deps.panesStore.replaceWorkspaceGrid({ machineId, workspaceId, grid: nextWorkspace.columns });
  if (!gridResult.applied) {
    return { ok: true, rev: gridResult.rev, workspaceId, applied: false, workspace: existingRecord ? toSnapshotDTO(existingRecord, grid) : null };
  }

  // Keep the legacy `layout` mirror current — see the module doc. Best-effort:
  // the relational rows just committed are the source of truth either way.
  const mirrored = await updateWorkspace({
    machineId,
    workspaceId,
    layout: { columns: nextWorkspace.columns },
    deps: deps.workspacesDeps,
  });
  if (!mirrored.ok) return mirrored;

  return {
    ok: true,
    rev: gridResult.rev,
    workspaceId,
    applied: true,
    workspace: toSnapshotDTO(mirrored.workspace, nextWorkspace.columns),
  };
}

/**
 * Broadcasts a successful `applyWorkspaceVerb` result under BOTH the new
 * verb+rev vocabulary and the legacy `created`/`updated`/`deleted` events
 * (see the module doc's rolling-deploy shim rationale) — a browser that
 * hasn't picked up phase-4's client rewrite yet still reconciles correctly.
 * A no-op result (`applied: false`) broadcasts nothing — there is nothing
 * for any listener to reconcile.
 */
export function broadcastWorkspaceVerbResult(machineId: string, verb: WorkspaceVerb, result: ApplyWorkspaceVerbResult): void {
  if (!result.ok || !result.applied) return;

  void broadcastMachineWorkspaceEvent(machineId, 'machine-workspace:verb', {
    machineId,
    rev: result.rev,
    verb: verb.type,
    workspaceId: result.workspaceId,
    workspace: result.workspace,
  });

  if (!result.workspace) {
    void broadcastMachineWorkspaceEvent(machineId, 'machine-workspace:deleted', { machineId, workspaceId: result.workspaceId });
    return;
  }

  if (verb.type === 'create-workspace') {
    void broadcastMachineWorkspaceEvent(machineId, 'machine-workspace:created', { machineId, ...result.workspace });
    return;
  }

  void broadcastMachineWorkspaceEvent(machineId, 'machine-workspace:updated', {
    machineId,
    workspaceId: result.workspaceId,
    ...(verb.type === 'rename-workspace' ? { name: result.workspace.name } : { columns: result.workspace.columns }),
  });
}

let panesStorePromise: ReturnType<typeof createDbMachinePanesStore> | null = null;
function getPanesStore() {
  panesStorePromise ??= createDbMachinePanesStore();
  return panesStorePromise;
}

/**
 * `GET`'s consistent read: the workspace list (legacy `machine_workspaces`
 * rows) and the machine's current rev, from ONE `REPEATABLE READ` snapshot —
 * so a grid-touching write racing this GET can't be observed half-applied
 * (a rev that already advanced paired with a `layout` mirror that hasn't
 * caught up yet, or vice versa). `REPEATABLE READ` (not the default `READ
 * COMMITTED`) is what actually buys this: every statement in the same
 * transaction sees the exact snapshot taken at the transaction's start,
 * not "whatever's committed as of each individual statement".
 */
export async function getConsistentWorkspaceSnapshot(
  machineId: string,
): Promise<{ workspaces: MachineWorkspaceRecord[]; rev: number }> {
  const { db } = await import('@pagespace/db/db');
  return db.transaction(
    async (tx) => {
      // Both stores bound to THIS transaction — the whole point: a plain
      // `db`-backed store here would read on a different connection/snapshot
      // than `tx`, silently reintroducing the inconsistency this exists to close.
      const [workspaces, rev] = await Promise.all([
        buildMachineWorkspacesDeps(tx).store.list(machineId),
        (await createDbMachinePanesStore(tx)).currentRev(machineId),
      ]);
      return { workspaces, rev };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/**
 * Legacy-route shim: mirrors a blob POST/PATCH/DELETE's effect into the
 * relational rows and bumps rev, so an old client (still speaking
 * `../route.ts`'s POST/PATCH/DELETE) is visible to new clients watching
 * `machine-workspace:verb`/rev, and a `GET` snapshot stays consistent
 * regardless of which route wrote last. `grid: null` means "metadata-only
 * change" (a legacy rename with no columns) — rev still advances, but no
 * pane rows are touched. Returns `applied: false` (rev unchanged) only when
 * `grid` is a byte-for-byte repeat of what's already stored.
 *
 * `executor` defaults to the memoized real-`db`-backed pane store; a legacy
 * route write passes the SAME transaction its metadata write used (see
 * `withLegacyWorkspaceLock`) so the two can never commit independently —
 * either both land, or (on a crash mid-transaction) neither does, closing
 * the "legacy write committed, relational sync silently failed" gap.
 */
export async function syncRelationalGrid(
  machineId: string,
  workspaceId: string,
  grid: WorkspaceGridColumnRecord[] | null,
  executor?: DbExecutor,
): Promise<{ rev: number; applied: boolean }> {
  const store = executor ? await createDbMachinePanesStore(executor) : await getPanesStore();
  if (grid === null) return { rev: await store.bumpRev(machineId), applied: true };
  return store.replaceWorkspaceGrid({ machineId, workspaceId, grid });
}

/**
 * THE production entry point for every legacy (`../route.ts`) write: holds
 * the SAME per-machine advisory lock `applyWorkspaceVerbLocked` does for the
 * ENTIRE metadata-write-plus-relational-sync cycle, in ONE transaction. This
 * closes two gaps at once: a concurrent write (legacy OR a new verb) for the
 * same machine can't interleave with this one (the lost-update class
 * `withMachineLock` exists for), and the metadata write and its relational
 * mirror commit atomically — a crash between them leaves NEITHER applied,
 * rather than a legacy row with no matching pane rows/rev.
 *
 * `mutate` receives the metadata deps AND the raw executor (both bound to
 * the lock's transaction) — do the `machine_workspaces` write with the
 * former, then call `syncRelationalGrid(..., executor)` with the latter.
 */
export async function withLegacyWorkspaceLock<T>(
  machineId: string,
  mutate: (deps: MachineWorkspacesDeps, executor: DbExecutor) => Promise<T>,
): Promise<T> {
  return withMachineLock(machineId, (tx) => mutate(buildMachineWorkspacesDeps(tx), tx));
}

/** Broadcasts the NEW verb+rev event for a legacy-route write, alongside
 * whatever legacy event the caller already emits — see `syncRelationalGrid`. */
export function broadcastLegacyGridSync(
  machineId: string,
  workspaceId: string,
  rev: number,
  workspace: WorkspaceSnapshotDTO | null,
): void {
  void broadcastMachineWorkspaceEvent(machineId, 'machine-workspace:verb', {
    machineId,
    rev,
    verb: 'legacy-write',
    workspaceId,
    workspace,
  });
}

/**
 * Builds the production `ApplyWorkspaceVerbDeps`, one call per request, same
 * laziness convention as `buildMachineWorkspacesDeps`.
 *
 * `executor` defaults to the memoized real-`db`-backed pane store above; pass
 * a transaction (from `withMachineLock`) to route every read AND write
 * through it instead — see `applyWorkspaceVerbLocked`, the caller that
 * actually needs this: an `executor`-less deps object is only safe for a
 * caller that doesn't need cross-request serialization (none of this repo's
 * callers qualify — every production call site goes through
 * `applyWorkspaceVerbLocked`; this parameter exists so `applyWorkspaceVerb`
 * itself stays a pure function of its `deps`, testable without a lock).
 */
export function buildApplyWorkspaceVerbDeps(ownerId: string, executor?: DbExecutor): ApplyWorkspaceVerbDeps {
  if (executor) {
    const lockedPanesStore = createDbMachinePanesStore(executor);
    return {
      workspacesDeps: buildMachineWorkspacesDeps(executor),
      panesStore: {
        getWorkspaceGrid: async (machineId, workspaceId) => (await lockedPanesStore).getWorkspaceGrid(machineId, workspaceId),
        getMachineGrids: async (machineId) => (await lockedPanesStore).getMachineGrids(machineId),
        replaceWorkspaceGrid: async (input) => (await lockedPanesStore).replaceWorkspaceGrid(input),
        bumpRev: async (machineId) => (await lockedPanesStore).bumpRev(machineId),
        currentRev: async (machineId) => (await lockedPanesStore).currentRev(machineId),
      },
      ownerId,
    };
  }

  return {
    workspacesDeps: buildMachineWorkspacesDeps(),
    panesStore: {
      getWorkspaceGrid: async (machineId, workspaceId) => (await getPanesStore()).getWorkspaceGrid(machineId, workspaceId),
      getMachineGrids: async (machineId) => (await getPanesStore()).getMachineGrids(machineId),
      replaceWorkspaceGrid: async (input) => (await getPanesStore()).replaceWorkspaceGrid(input),
      bumpRev: async (machineId) => (await getPanesStore()).bumpRev(machineId),
      currentRev: async (machineId) => (await getPanesStore()).currentRev(machineId),
    },
    ownerId,
  };
}

/**
 * THE production entry point for every verb mutation (the HTTP route and the
 * AI session tools both call this, not `applyWorkspaceVerb` directly): holds
 * the per-machine advisory lock for the ENTIRE read-reduce-write cycle, so a
 * concurrent verb for the same machine can never read the grid this call is
 * about to overwrite (see `machine-panes-store.ts`'s `withMachineLock` doc
 * for why `replaceWorkspaceGrid`'s own internal transaction alone isn't
 * enough — the caller's READ has to be inside the lock too, not just the
 * write).
 */
export async function applyWorkspaceVerbLocked(machineId: string, verb: WorkspaceVerb, ownerId: string): Promise<ApplyWorkspaceVerbResult> {
  return withMachineLock(machineId, (tx) => applyWorkspaceVerb(machineId, verb, buildApplyWorkspaceVerbDeps(ownerId, tx)));
}
