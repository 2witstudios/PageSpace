/**
 * Machine Workspaces: create / rename / update-layout / remove / list a
 * Machine's shared, named pane-grid workspaces (IO, dependency-injected).
 *
 * Unlike `machine-projects.ts`/`machine-branches.ts`, this is pure metadata
 * CRUD — no sandbox/git I/O, so `deps` is just `{ store, now }`.
 *
 * `createWorkspace` is idempotent-by-id (first writer wins): the workspace
 * `id` is minted CLIENT-side (either `crypto.randomUUID()` or the
 * deterministic `sessionWorkspaceId(scope)` — see workspace-reducer.ts), so
 * two browsers racing to materialize the SAME session-derived workspace is a
 * legitimate, expected case, not an error — the loser just gets the winner's
 * row back.
 *
 * Entity promotion (#2202) made `machine_workspaces.layout` a rolling-deploy
 * shim rather than the source of truth (see `machine-panes-store.ts` and
 * `apps/web/src/lib/machines/workspace-verbs-runtime.ts`) and retired the
 * one-time `bootstrapWorkspaces` localStorage-seed claim entirely — the
 * server has been the sole source of truth since #2048 shipped, so there is
 * no un-migrated browser history left to claim.
 */

export type MachineWorkspaceScope = 'machine' | 'project' | 'branch';

export interface WorkspaceScopeInput {
  projectName?: string;
  branchName?: string;
}

/** Mirrors the client's `OpenTerminalScope`/pane shape — see machine-workspaces-store.ts's DTOs. */
export interface WorkspaceLayoutPaneInput {
  id: string;
  scope: { projectName?: string; branchName?: string; name: string; kind?: 'terminal' | 'chat' } | null;
}
export interface WorkspaceLayoutColumnInput {
  id: string;
  panes: WorkspaceLayoutPaneInput[];
}
export interface WorkspaceLayoutInput {
  columns: WorkspaceLayoutColumnInput[];
}

import {
  isUniqueViolation,
  type MachineWorkspaceStore,
  type MachineWorkspaceRecord,
  type NewMachineWorkspaceInput,
} from './machine-workspaces-store';

export type WorkspacePlanDenialReason = 'invalid_name' | 'invalid_columns';

function isValidLayout(layout: unknown): layout is WorkspaceLayoutInput {
  if (typeof layout !== 'object' || layout === null) return false;
  const candidate = layout as Partial<WorkspaceLayoutInput>;
  if (!Array.isArray(candidate.columns) || candidate.columns.length === 0) return false;
  return candidate.columns.every((column) => {
    if (typeof column !== 'object' || column === null) return false;
    const col = column as Partial<WorkspaceLayoutColumnInput>;
    if (typeof col.id !== 'string' || !Array.isArray(col.panes) || col.panes.length === 0) return false;
    return col.panes.every((pane) => {
      if (typeof pane !== 'object' || pane === null) return false;
      const p = pane as Partial<WorkspaceLayoutPaneInput>;
      if (typeof p.id !== 'string') return false;
      if (p.scope === null) return true;
      return typeof p.scope === 'object' && typeof (p.scope as { name?: unknown }).name === 'string';
    });
  });
}

/** Derives the `scope` discriminant from which of `projectName`/`branchName` are set —
 * the inverse of the client's `nodeOfTerminalScope`. */
export function deriveWorkspaceScope(input: WorkspaceScopeInput): MachineWorkspaceScope {
  if (input.branchName) return 'branch';
  if (input.projectName) return 'project';
  return 'machine';
}

export function isValidWorkspaceName(name: unknown): name is string {
  return typeof name === 'string' && name.trim().length > 0;
}

/** Pure shape validation for a create payload — no I/O. */
export function planWorkspacePayload({
  name,
  layout,
}: {
  name: string;
  layout: unknown;
}): { ok: true; name: string; layout: WorkspaceLayoutInput } | { ok: false; reason: WorkspacePlanDenialReason } {
  if (!isValidWorkspaceName(name)) return { ok: false, reason: 'invalid_name' };
  if (!isValidLayout(layout)) return { ok: false, reason: 'invalid_columns' };
  // Trimmed here so create and rename persist the same string for the same
  // input — `updateWorkspace` already trims on rename; this path (create AND
  // bootstrap seeding, both of which route through this function) did not.
  return { ok: true, name: name.trim(), layout };
}

export interface MachineWorkspacesDeps {
  store: MachineWorkspaceStore;
  now: () => Date;
}

export async function listWorkspaces({
  machineId,
  store,
}: {
  machineId: string;
  store: MachineWorkspaceStore;
}): Promise<MachineWorkspaceRecord[]> {
  return store.list(machineId);
}

export type CreateWorkspaceResult =
  | { ok: true; created: boolean; workspace: MachineWorkspaceRecord }
  | { ok: false; reason: WorkspacePlanDenialReason };

export async function createWorkspace({
  machineId,
  ownerId,
  id,
  name,
  scope,
  layout,
  deps,
}: {
  machineId: string;
  ownerId: string;
  id: string;
  name: string;
  scope: WorkspaceScopeInput;
  layout: unknown;
  deps: MachineWorkspacesDeps;
}): Promise<CreateWorkspaceResult> {
  const plan = planWorkspacePayload({ name, layout });
  if (!plan.ok) return plan;

  const input: NewMachineWorkspaceInput = {
    id,
    ownerId,
    machineId,
    scope: deriveWorkspaceScope(scope),
    projectName: scope.projectName ?? null,
    branchName: scope.branchName ?? null,
    name: plan.name,
    layout: plan.layout,
    now: deps.now(),
  };

  const { created, row } = await deps.store.insertIfAbsent(input);
  return { ok: true, created, workspace: row };
}

export type UpdateWorkspaceResult =
  | { ok: true; workspace: MachineWorkspaceRecord }
  | { ok: false; reason: WorkspacePlanDenialReason | 'not_found' };

export async function updateWorkspace({
  machineId,
  workspaceId,
  name,
  layout,
  deps,
}: {
  machineId: string;
  workspaceId: string;
  name?: string;
  layout?: unknown;
  deps: MachineWorkspacesDeps;
}): Promise<UpdateWorkspaceResult> {
  const patch: { name?: string; layout?: WorkspaceLayoutInput } = {};

  if (name !== undefined) {
    if (!isValidWorkspaceName(name)) return { ok: false, reason: 'invalid_name' };
    patch.name = name.trim();
  }
  if (layout !== undefined) {
    if (!isValidLayout(layout)) return { ok: false, reason: 'invalid_columns' };
    patch.layout = layout;
  }

  const row = await deps.store.update(machineId, workspaceId, patch, deps.now());
  if (!row) return { ok: false, reason: 'not_found' };
  return { ok: true, workspace: row };
}

export type RemoveWorkspaceResult = { ok: true } | { ok: false; reason: 'not_found' };

export async function removeWorkspace({
  machineId,
  workspaceId,
  store,
}: {
  machineId: string;
  workspaceId: string;
  store: MachineWorkspaceStore;
}): Promise<RemoveWorkspaceResult> {
  const removed = await store.remove(machineId, workspaceId);
  if (!removed) return { ok: false, reason: 'not_found' };
  return { ok: true };
}

/** Re-exported so callers can classify a create rejection without importing the store directly. */
export { isUniqueViolation };
