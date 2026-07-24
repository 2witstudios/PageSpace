/**
 * Machine Workspace — functional core.
 *
 * Pure, framework-free state transitions for the Machine page's middle view.
 * IDs are passed in rather than generated here, so every transition is
 * deterministic and independently testable.
 *
 * THE MODEL (PurePoint-exact): a **workspace** is a sidebar item that OWNS a
 * pane grid. A machine holds MANY workspaces and exactly one is active; the
 * middle view always renders the active workspace's grid, so selecting a
 * different workspace switches the WHOLE middle view to that item's combination
 * of terminals. (What it replaces: one grid per machine, where opening a
 * terminal only overwrote the active pane and the view never really switched.)
 *
 * Two levels, therefore two kinds of transition here:
 *   - grid-level  (WorkspaceState): the existing two-level column/pane split —
 *     a horizontal row of columns, each an independent vertical stack of panes.
 *     Deliberately NOT a recursive split tree. splitRight adds a column;
 *     splitDown stacks within one. Unchanged, now applied PER workspace.
 *   - machine-level (MachineWorkspacesState): which workspaces exist, their
 *     order, and which one is active.
 */

/** Identifies which terminal to open in a pane — neither `projectName` nor
 * `branchName` set is machine scope, `projectName` alone is project scope,
 * both is branch scope. */
export interface OpenTerminalScope {
  projectName?: string;
  branchName?: string;
  name: string;
  /** What the pane renders once bound: an xterm PTY, or the PageSpace Agent
   * chat UI (#2166). Omitted means `'terminal'` — every session bound before
   * this tag existed is a PTY, so the renderer can treat a missing kind the
   * same as an explicit one without a migration. Lives on the scope, not a
   * loose `agentType` string, so it survives every place a scope already
   * flows opaquely (assignPane, sanitizeMachines, mergeServerWorkspaces)
   * without those transitions needing to know about it. */
  kind?: 'terminal' | 'chat';
}

/**
 * The node container a workspace lives under. Nodes are STRUCTURE, not the
 * grid-owning unit: a workspace's scope says which checkout its panes' agents
 * run in (a branch scope = that branch's working tree), while the grid itself
 * belongs to the workspace.
 *
 * A DISCRIMINATED UNION, mirroring `machine_workspaces.scope`'s
 * `'machine' | 'project' | 'branch'` column. The old
 * `{projectName?, branchName?}` bag made two nonsense shapes expressible — a
 * branch with no project, and "did the caller mean machine scope or did it
 * forget to pass one" — and left every consumer to re-derive which of the
 * three it was holding, each with its own `if (!projectName)` ladder. With the
 * discriminant, `nodeScopeOf`/`scopeLabelOf` are TOTAL switches: a fourth node
 * kind fails compilation at every one of them instead of silently falling into
 * somebody's `else`.
 *
 * The names are still what crosses the wire ({@link nodeScopeNames}) — the
 * server derives its own discriminant from them (`deriveWorkspaceScope`), so
 * this is a client-side modelling device, not a protocol change.
 */
export type MachineNodeScope =
  | { level: 'machine' }
  | { level: 'project'; projectName: string }
  | { level: 'branch'; projectName: string; branchName: string };

/** The Machine node itself (neither project nor branch). A shared constant so
 * callers can hand out a stable default without a new object per render. */
export const MACHINE_NODE_SCOPE: MachineNodeScope = Object.freeze({ level: 'machine' });

/** The `{projectName?, branchName?}` half — what every API call that addresses
 * a checkout sends, and what `machine_agent_terminals`/`machine_workspaces`
 * actually store. The discriminant never crosses the wire. */
export function nodeScopeNames(scope: MachineNodeScope): { projectName?: string; branchName?: string } {
  switch (scope.level) {
    case 'machine':
      return {};
    case 'project':
      return { projectName: scope.projectName };
    case 'branch':
      return { projectName: scope.projectName, branchName: scope.branchName };
  }
}

/**
 * The client mirror of the server's `deriveWorkspaceScope`: which node kind a
 * pair of names describes. The discriminant is DERIVED, never trusted from
 * input — so a stored/received `level` that disagrees with the names it sits
 * beside cannot exist, and every legacy `{projectName, branchName}` payload
 * (localStorage, an older client's server row) reads correctly with no
 * migration step.
 *
 * A branchName with no projectName is not a branch: branches are addressed
 * under their project everywhere, so the name alone identifies nothing.
 */
export function machineNodeScope(names: { projectName?: string; branchName?: string }): MachineNodeScope {
  if (!names.projectName) return MACHINE_NODE_SCOPE;
  return names.branchName
    ? { level: 'branch', projectName: names.projectName, branchName: names.branchName }
    : { level: 'project', projectName: names.projectName };
}

/** The node a session lives under — a session's scope IS a node plus a name. */
export function nodeOfTerminalScope(scope: OpenTerminalScope): MachineNodeScope {
  return machineNodeScope(scope);
}

export function isSameNodeScope(a: MachineNodeScope, b: MachineNodeScope): boolean {
  switch (a.level) {
    case 'machine':
      return b.level === 'machine';
    case 'project':
      return b.level === 'project' && b.projectName === a.projectName;
    case 'branch':
      return b.level === 'branch' && b.projectName === a.projectName && b.branchName === a.branchName;
  }
}

/** A node scope rendered for an error message — never parsed, never persisted. */
function scopeKey(scope: MachineNodeScope): string {
  switch (scope.level) {
    case 'machine':
      return 'the machine';
    case 'project':
      return scope.projectName;
    case 'branch':
      return `${scope.projectName}/${scope.branchName}`;
  }
}

/**
 * What a bound pane STORES about its session: the name, and what it renders as.
 * Deliberately NOT the checkout — that is {@link WorkspaceState.scope}, and a
 * pane's checkout is always its workspace's.
 *
 * The pane used to carry a full {@link OpenTerminalScope}, which made a
 * "foreign" pane (one whose project/branch disagreed with its workspace's)
 * representable. Nothing ever wrote one — every bind path spawns at the
 * workspace's scope — but every reader had to defend against one anyway, and
 * the two copies of the checkout could in principle disagree with no rule for
 * which wins. Narrowing deletes the whole class: `sessionWorkspaceId`,
 * `paneSessionId`, the kill address and the surface decision all re-derive
 * from one source. Rebuild the full address with {@link paneTerminalScope}.
 */
export interface PaneSessionScope {
  name: string;
  /** See {@link OpenTerminalScope.kind} — omitted means `'terminal'`. */
  kind?: 'terminal' | 'chat';
}

export interface TerminalPaneState {
  id: string;
  scope: PaneSessionScope | null;
  /** Typed into the agent's PTY once it's ready, then cleared — a pane that
   * re-mounts (tab switch, reattach) must not re-send the starting prompt. */
  pendingPrompt?: string;
}

/** The full session address a pane resolves to: its workspace's checkout plus
 * its own name. THE join point — every read site that needs a (project,
 * branch, name) triple builds it here rather than reading a stored copy. */
export function paneTerminalScope(node: MachineNodeScope, pane: PaneSessionScope): OpenTerminalScope {
  return {
    ...nodeScopeNames(node),
    name: pane.name,
    ...(pane.kind === undefined ? {} : { kind: pane.kind }),
  };
}

/** The half of a full session address a pane keeps — the projection applied at
 * bind time. */
export function paneScopeOf(scope: OpenTerminalScope): PaneSessionScope {
  return scope.kind === undefined ? { name: scope.name } : { name: scope.name, kind: scope.kind };
}

/**
 * The pane scope as it goes ON THE WIRE — the narrowed shape PLUS the
 * workspace's checkout names (issue #2204 follow-up, F13).
 *
 * Narrowing the pane deleted a real class of bug in THIS client, but a pane
 * scope is also persisted and broadcast, and the wire has older readers on it:
 * mid rolling-deploy, or a browser tab left open across one. A pre-narrowing
 * client reads a name-only pane as a MACHINE-ROOT session — so a project pane
 * named `worker` resolves to the ROOT's `worker`, and that client will connect
 * to, or KILL, the wrong session.
 *
 * So the wire keeps the full address while local state keeps the narrow one.
 * The duplication cannot rot here because it exists only in transit: nothing in
 * this version reads these fields back ({@link projectStoredPaneScope} drops
 * them on the way in, and {@link paneTerminalScope} is the single join point
 * for a pane's checkout). Delete once no pre-narrowing client can still run.
 */
export function paneScopeForWire(
  node: MachineNodeScope,
  pane: PaneSessionScope | null,
): (PaneSessionScope & { projectName?: string; branchName?: string }) | null {
  if (!pane) return null;
  const names = nodeScopeNames(node);
  return {
    ...pane,
    ...(names.projectName ? { projectName: names.projectName } : {}),
    ...(names.branchName ? { branchName: names.branchName } : {}),
  };
}

/**
 * Read-time projection of a STORED node scope, from either shape: the union
 * this version writes, or the bare `{projectName, branchName}` an older client
 * (or a not-yet-redeployed server) sends. The discriminant is re-derived from
 * the names either way, so the two can never disagree.
 */
export function projectStoredNodeScope(value: unknown): MachineNodeScope | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { projectName?: unknown; branchName?: unknown };
  return machineNodeScope({
    ...(typeof candidate.projectName === 'string' && candidate.projectName.length > 0
      ? { projectName: candidate.projectName }
      : {}),
    ...(typeof candidate.branchName === 'string' && candidate.branchName.length > 0
      ? { branchName: candidate.branchName }
      : {}),
  });
}

/**
 * Read-time projection of a STORED pane scope — the whole Phase-1 migration.
 *
 * A layout written by an older client (localStorage, or another browser's
 * server payload) still carries `{projectName, branchName}` on the pane. There
 * is nothing to reconcile: a wide pane was representable but never written
 * disagreeing with its workspace, so the duplicated checkout is simply dropped
 * on the way in. No backfill, no migration step, no version bump — both merge
 * paths (`mergeColumns` and `sanitizeMachines`) funnel through here.
 */
export function projectStoredPaneScope(value: unknown): PaneSessionScope | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { name?: unknown; kind?: unknown };
  if (typeof candidate.name !== 'string') return null;
  return candidate.kind === 'chat' || candidate.kind === 'terminal'
    ? { name: candidate.name, kind: candidate.kind }
    : { name: candidate.name };
}

export interface TerminalColumnState {
  id: string;
  panes: TerminalPaneState[];
}

/** One sidebar item's pane grid. */
export interface WorkspaceState {
  id: string;
  /** Auto-named — the user is never asked. Shown in the sidebar by sub-task 3. */
  name: string;
  /** The node container this workspace hangs under; every agent spawned into
   * one of its panes runs in this scope's checkout. */
  scope: MachineNodeScope;
  columns: TerminalColumnState[];
  activePaneId: string;
  /** The empty pane whose inline agent picker should take focus — set when a
   * split makes a new pane, so the user lands in the picker instead of staring
   * at a blank pane. Cleared once that pane is filled or the picker is left. */
  pendingPickerPaneId: string | null;
}

/** Every workspace of one machine, plus which one the middle view is showing. */
export interface MachineWorkspacesState {
  workspaces: Record<string, WorkspaceState>;
  /** Sidebar order — insertion order, stable across selection. */
  order: string[];
  /** `''` when nothing is active — a machine with zero workspaces is a legal,
   * converged state (the middle view renders its empty state), not a bug to
   * repair by fabricating one. No workspace id can be `''` (`crypto.randomUUID`
   * / `sessionWorkspaceId` both produce non-empty), so this sentinel can never
   * collide with a real id: `workspaces['']` never resolves and
   * `setActiveWorkspace(state, '')` correctly no-ops. */
  activeWorkspaceId: string;
}

// ---------------------------------------------------------------------------
// Grid level — one workspace's panes
// ---------------------------------------------------------------------------

export function newWorkspace(params: {
  id: string;
  name: string;
  scope: MachineNodeScope;
  firstPaneId: string;
  /** A workspace born from an existing session opens with that session in its
   * first pane; one born empty opens with the agent picker. */
  firstPaneScope?: PaneSessionScope | null;
}): WorkspaceState {
  const { id, name, scope, firstPaneId, firstPaneScope = null } = params;
  return {
    id,
    name,
    scope,
    columns: [{ id: firstPaneId, panes: [{ id: firstPaneId, scope: firstPaneScope }] }],
    activePaneId: firstPaneId,
    pendingPickerPaneId: null,
  };
}

function findPaneLocation(
  state: WorkspaceState,
  paneId: string
): { columnIndex: number; paneIndex: number } | null {
  for (let columnIndex = 0; columnIndex < state.columns.length; columnIndex++) {
    const paneIndex = state.columns[columnIndex].panes.findIndex((pane) => pane.id === paneId);
    if (paneIndex !== -1) return { columnIndex, paneIndex };
  }
  return null;
}

/** Rewrites one pane in place. A `paneId` that doesn't resolve is a no-op —
 * the caller gets the same object back, so identity checks still hold. */
function mapPane(
  state: WorkspaceState,
  paneId: string,
  update: (pane: TerminalPaneState) => TerminalPaneState
): WorkspaceState {
  if (!findPaneLocation(state, paneId)) return state;
  return {
    ...state,
    columns: state.columns.map((column) => ({
      ...column,
      panes: column.panes.map((pane) => (pane.id === paneId ? update(pane) : pane)),
    })),
  };
}

/**
 * Binds a session to a SPECIFIC pane — the landing half of split-and-pick. The
 * picker spawns an agent and drops it straight into the pane it was picked in,
 * which by the time the spawn resolves may no longer be the active one (the
 * user can click another pane while a cold Sprite boots), so the target is
 * explicit rather than "wherever focus happens to be".
 *
 * The pane becomes active, and its picker stops pending — it holds a terminal
 * now, so there is nothing left to pick.
 */
export function assignPane(
  state: WorkspaceState,
  paneId: string,
  scope: OpenTerminalScope,
  pendingPrompt?: string
): WorkspaceState {
  // BIND-TIME NODE EQUALITY. A pane's checkout is its workspace's, so there is
  // no representation for a session at another node — the narrow pane scope
  // would silently record the NAME under this workspace's checkout, filing the
  // session under a checkout it does not run in. That is a caller bug (a spawn
  // addressed at the wrong node), not a race the UI can converge out of, so it
  // throws rather than returning the "pane is gone" false, which callers answer
  // by KILLING the session they just created.
  if (!isSameNodeScope(nodeOfTerminalScope(scope), state.scope)) {
    throw new Error(
      `Cannot bind session "${scope.name}" at ${scopeKey(nodeOfTerminalScope(scope))} into workspace "${state.id}" at ${scopeKey(state.scope)} — a pane's checkout is its workspace's`
    );
  }

  const next = mapPane(state, paneId, (pane) => ({ ...pane, scope: paneScopeOf(scope), pendingPrompt }));
  if (next === state) return state;

  return {
    ...next,
    activePaneId: paneId,
    pendingPickerPaneId: state.pendingPickerPaneId === paneId ? null : state.pendingPickerPaneId,
  };
}

/** Drops the starting prompt once it has been typed into the PTY, so a pane
 * that re-mounts later reattaches to a running agent instead of typing the
 * prompt at it a second time. */
export function clearPanePrompt(state: WorkspaceState, paneId: string): WorkspaceState {
  return mapPane(state, paneId, (pane) =>
    pane.pendingPrompt === undefined ? pane : { ...pane, pendingPrompt: undefined }
  );
}

/**
 * Sets ONLY `pendingPrompt` on an existing pane, leaving its `scope`
 * untouched — the restore half of `clearPanePrompt`. A `WorkspaceVerb` (see
 * `workspace-verbs.ts`) carries no `pendingPrompt` field at all (it is
 * local-only, never crossing the wire), so `applyVerbLocal`'s `bind-pane`
 * case can't preserve one through a rebase on its own; this is the primitive
 * a caller (`useMachineWorkspaceStore`'s `rebasePendingVerbs`) uses to
 * restore a prompt a pending bind had already set, after replaying that same
 * verb on top of fresher server state. A `paneId` that doesn't resolve is a
 * no-op, same as every other transition here.
 */
export function restorePanePendingPrompt(state: WorkspaceState, paneId: string, pendingPrompt: string): WorkspaceState {
  return mapPane(state, paneId, (pane) => (pane.pendingPrompt === pendingPrompt ? pane : { ...pane, pendingPrompt }));
}

/** The picker no longer wants focus. The pane stays empty and still offers its
 * picker — this only clears the auto-focus intent left by the split that made
 * it, so focus isn't yanked back on every unrelated re-render. */
export function dismissPicker(state: WorkspaceState, paneId: string): WorkspaceState {
  if (state.pendingPickerPaneId !== paneId) return state;
  return { ...state, pendingPickerPaneId: null };
}

/** Splits `fromPaneId` rightward — a new column, with one new pane, inserted
 * immediately after `fromPaneId`'s column. A `fromPaneId` that no longer
 * resolves (e.g. a stale click racing a close) is a no-op, same as every
 * other transition here. */
export function splitRight(
  state: WorkspaceState,
  fromPaneId: string,
  newColumnId: string,
  newPaneId: string
): WorkspaceState {
  const location = findPaneLocation(state, fromPaneId);
  if (!location) return state;

  const columns = [...state.columns];
  columns.splice(location.columnIndex + 1, 0, { id: newColumnId, panes: [{ id: newPaneId, scope: null }] });

  // The new pane is empty, so it shows the agent picker; pointing
  // pendingPickerPaneId at it opens that picker focused, rather than leaving
  // the user looking at a blank pane and hunting for the next click.
  return { ...state, columns, activePaneId: newPaneId, pendingPickerPaneId: newPaneId };
}

/** Splits `fromPaneId` downward — a new pane appended to `fromPaneId`'s
 * existing column. */
export function splitDown(state: WorkspaceState, fromPaneId: string, newPaneId: string): WorkspaceState {
  const location = findPaneLocation(state, fromPaneId);
  if (!location) return state;

  const columns = state.columns.map((column, columnIndex) =>
    columnIndex === location.columnIndex
      ? { ...column, panes: [...column.panes, { id: newPaneId, scope: null }] }
      : column
  );

  return { ...state, columns, activePaneId: newPaneId, pendingPickerPaneId: newPaneId };
}

/**
 * Removes a pane from its grid. Closing the last pane in a column removes the
 * column too; closing the active pane re-targets active to the first remaining
 * pane.
 *
 * A workspace never has zero panes, so the LAST pane is not this function's
 * business — removing it means removing the workspace, which a `WorkspaceState`
 * transition cannot do to its own container. {@link closePaneIn} owns that case
 * and intercepts before calling here; this no-ops as a backstop rather than
 * filtering the grid down to a `columns[0]` that isn't there.
 */
export function closePane(state: WorkspaceState, id: string): WorkspaceState {
  const location = findPaneLocation(state, id);
  if (!location) return state;

  const totalPanes = state.columns.reduce((sum, column) => sum + column.panes.length, 0);
  if (totalPanes <= 1) return state;

  const columns = state.columns
    .map((column, columnIndex) =>
      columnIndex === location.columnIndex
        ? { ...column, panes: column.panes.filter((pane) => pane.id !== id) }
        : column
    )
    .filter((column) => column.panes.length > 0);

  const activePaneId = state.activePaneId === id ? columns[0].panes[0].id : state.activePaneId;
  const pendingPickerPaneId = state.pendingPickerPaneId === id ? null : state.pendingPickerPaneId;

  return { ...state, columns, activePaneId, pendingPickerPaneId };
}

export function selectPane(state: WorkspaceState, id: string): WorkspaceState {
  if (!findPaneLocation(state, id)) return state;
  return { ...state, activePaneId: id };
}

/** Every pane of a workspace, flattened — the panes are what the sidebar must
 * NOT list separately (a split pane belongs to its workspace, not to the tree). */
export function panesOf(state: WorkspaceState): TerminalPaneState[] {
  return state.columns.flatMap((column) => column.panes);
}

// ---------------------------------------------------------------------------
// Machine level — which workspaces exist, and which one the view shows
// ---------------------------------------------------------------------------

/**
 * `true` for a property name that could redefine an object's prototype or
 * shadow an inherited member when used as a computed key on a plain object
 * (`{ ...obj, [key]: value }`, or a bare `obj[key]` read/delete) —
 * `"__proto__"`/`"constructor"`/`"prototype"`. Workspace ids are
 * `crypto.randomUUID()` or `sessionWorkspaceId()`-derived and never
 * legitimately collide with these, so treating them as absent/unwritable is
 * a pure no-op for every real caller; it exists only to keep an
 * attacker-controlled workspace id (verbs carry one straight from the
 * request body — see `parseWorkspaceVerb`) from reaching a computed-key
 * write or shadowing an inherited lookup on `state.workspaces`.
 */
function isUnsafeRecordKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

/** Own-property membership for a `workspaces` record — never true for a key
 * that only resolves via the prototype chain (`"constructor"`, `"__proto__"`
 * on a plain object are truthy through inheritance, not presence). */
function hasWorkspace(state: MachineWorkspacesState, workspaceId: string): boolean {
  return !isUnsafeRecordKey(workspaceId) && Object.hasOwn(state.workspaces, workspaceId);
}

/** Adds a workspace and shows it — a workspace is created because the user
 * asked for it, so it is what they want to be looking at. */
export function addWorkspace(state: MachineWorkspacesState, workspace: WorkspaceState): MachineWorkspacesState {
  if (hasWorkspace(state, workspace.id)) return setActiveWorkspace(state, workspace.id);
  if (workspace.id === '__proto__' || workspace.id === 'constructor' || workspace.id === 'prototype') return state;
  return {
    // codeql[js/remote-property-injection] -- workspace.id is checked against
    // the exact dangerous key set immediately above (inline, not via a helper,
    // so CodeQL's sanitizer barrier recognizes it); any other key is a plain
    // own-property on a fresh object-literal spread, which is by construction
    // not exploitable for prototype pollution.
    workspaces: { ...state.workspaces, [workspace.id]: workspace },
    order: [...state.order, workspace.id],
    activeWorkspaceId: workspace.id,
  };
}

/**
 * THE FIX: selecting a workspace switches the ENTIRE middle view to that
 * workspace's grid — every pane, in the layout it was left in — not just the
 * contents of one pane. An unknown id is a no-op rather than a blank view.
 */
export function setActiveWorkspace(state: MachineWorkspacesState, workspaceId: string): MachineWorkspacesState {
  if (!hasWorkspace(state, workspaceId) || state.activeWorkspaceId === workspaceId) return state;
  return { ...state, activeWorkspaceId: workspaceId };
}

/** Applies a grid transition to ONE workspace, addressed by id.
 *
 * Callers name the workspace EXPLICITLY rather than letting this resolve
 * "the active one" at write time: a write can land after the user has switched
 * workspaces (a spawn resolving from a cold Sprite boot, a `ready` event), and
 * pane ids only mean anything within their own grid. Resolving late would apply
 * the write to whichever grid happened to be on screen by then — usually one
 * with no such pane, silently dropping it. */
export function updateWorkspace(
  state: MachineWorkspacesState,
  workspaceId: string,
  transition: (workspace: WorkspaceState) => WorkspaceState
): MachineWorkspacesState {
  if (!hasWorkspace(state, workspaceId)) return state;
  const workspace = state.workspaces[workspaceId];

  const next = transition(workspace);
  if (next === workspace) return state;

  return { ...state, workspaces: { ...state.workspaces, [workspaceId]: next } };
}

/** Renames one workspace, addressed by id — same explicit-id convention as
 * every other machine-level transition here (never "the active one"). */
export function renameWorkspace(state: MachineWorkspacesState, workspaceId: string, name: string): MachineWorkspacesState {
  return updateWorkspace(state, workspaceId, (workspace) => (workspace.name === name ? workspace : { ...workspace, name }));
}

export function workspacesOf(state: MachineWorkspacesState): WorkspaceState[] {
  return state.order.map((id) => state.workspaces[id]).filter(Boolean);
}

/**
 * The sessions that live INSIDE a workspace rather than being one.
 *
 * A workspace opened from a session row is that session's own item (its id is
 * `sessionWorkspaceId(scope)`), and belongs in the sidebar. Every other bound
 * pane is a CHILD: an agent the user spawned into a workspace by splitting and
 * picking. Those must not surface as their own sidebar rows — a split pane
 * belongs to the workspace that owns it, and listing it separately would put the
 * same agent in two places and undo the one-row-per-workspace model.
 *
 * Returned as `sessionWorkspaceId`-shaped keys, so a caller holding a session's
 * scope can test membership without re-deriving the naming rule. (The sidebar
 * that consumes this lands with the shared-tree work; the derivation belongs
 * here, with the state it reads.)
 */
export function childSessionIds(state: MachineWorkspacesState): Set<string> {
  const children = new Set<string>();

  for (const workspace of workspacesOf(state)) {
    for (const pane of panesOf(workspace)) {
      if (!pane.scope) continue;
      // Re-derived through the OWNING workspace's checkout — the pane carries
      // only a name, and a bare name is not a session identity.
      const id = sessionWorkspaceId(paneTerminalScope(workspace.scope, pane.scope));
      if (id !== workspace.id) children.add(id);
    }
  }

  return children;
}

/** How many panes of this machine are running an agent — the "N running" count
 * a node shows instead of listing its sessions. Counts PANES, since that is what
 * a running agent occupies. */
export function runningPaneCount(state: MachineWorkspacesState, scope?: MachineNodeScope): number {
  return workspacesOf(state)
    .filter((workspace) => scope === undefined || isSameNodeScope(workspace.scope, scope))
    .reduce((total, workspace) => total + panesOf(workspace).filter((pane) => pane.scope !== null).length, 0);
}

/** Is this session in one of `workspace`'s panes? */
export function paneShowing(workspace: WorkspaceState, scope: OpenTerminalScope): TerminalPaneState | undefined {
  // A session IS its node scope plus a name, so both halves have to match: two
  // branches of one project can each run an agent called `claude-a1b2c3`. The
  // node half is now the WORKSPACE's — checked once, here, instead of per pane.
  if (!isSameNodeScope(workspace.scope, nodeOfTerminalScope(scope))) return undefined;
  return panesOf(workspace).find((pane) => pane.scope != null && pane.scope.name === scope.name);
}

/**
 * The workspace this session is ALREADY a pane of, if any.
 *
 * A session need not live in the workspace its own id would name: split-and-pick
 * binds a brand-new session into whichever pane it was picked in, which belongs
 * to some other workspace. Opening such a session by minting the workspace its
 * id names would take the user away from the grid they actually built it in, and
 * leave the same PTY claimed by panes in two workspaces at once.
 */
export function workspaceShowing(
  state: MachineWorkspacesState,
  scope: OpenTerminalScope
): WorkspaceState | undefined {
  return workspacesOf(state).find((workspace) => paneShowing(workspace, scope) !== undefined);
}

/**
 * Puts `scope`'s session in front of the user inside its own workspace.
 *
 * Re-selecting the workspace is NOT enough on its own. The workspace is the
 * unit, and its panes move: the user can split, spawn other agents, and close
 * the very pane the session was opened in. Then clicking that session's sidebar
 * row again would just show a grid that no longer contains it — the session
 * would be unreachable from the sidebar for good, while its PTY kept running
 * (and billing) on the server.
 *
 * So: focus the pane already showing it, or put it in an empty pane, or split a
 * new pane for it.
 */
export function showSessionIn(
  workspace: WorkspaceState,
  scope: OpenTerminalScope,
  newPaneId: string
): WorkspaceState {
  const showing = paneShowing(workspace, scope);
  if (showing) return selectPane(workspace, showing.id);

  const panes = panesOf(workspace);
  const empty = panes.find((pane) => pane.scope === null);
  if (empty) return assignPane(workspace, empty.id, scope);

  // Anchor the split on a pane that certainly exists. `activePaneId` is the
  // right one to grow from, but every transition here no-ops on a pane id it
  // cannot resolve — so anchoring on a stale one would quietly do nothing and
  // the session would never appear, which is the exact failure this function
  // exists to prevent.
  const anchor = panes.some((pane) => pane.id === workspace.activePaneId) ? workspace.activePaneId : panes[0].id;
  return assignPane(splitDown(workspace, anchor, newPaneId), newPaneId, scope);
}

/**
 * Removes a workspace and shows a neighbour — including the LAST one, which
 * leaves the machine with zero workspaces and `activeWorkspaceId: ''`.
 *
 * A workspace is a VIEW of terminals, and a view you cannot destroy is not a
 * view. The old "a machine always keeps at least one" floor made the last row
 * permanently unremovable: the sidebar compensated by emptying its panes in
 * place, so the row survived every removal attempt, and `createWorkspace` then
 * added a SECOND row beside the zombie. Zero workspaces is the honest state,
 * and the middle view renders an empty state for it.
 */
export function removeWorkspace(state: MachineWorkspacesState, workspaceId: string): MachineWorkspacesState {
  if (!hasWorkspace(state, workspaceId)) return state;

  const order = state.order.filter((id) => id !== workspaceId);
  const workspaces = { ...state.workspaces };
  delete workspaces[workspaceId];

  // Falling back to the neighbour it sat next to, rather than to the first
  // workspace — closing one item should not jump the view across the sidebar.
  // The `?? ''` carries the empty case: `order[Math.min(n, -1)]` is `order[-1]`
  // — `undefined`, which would flow into a field typed `string` unchecked
  // (`noUncheckedIndexedAccess` is off) and read downstream as "not mounted yet"
  // rather than "nothing active".
  const removedIndex = state.order.indexOf(workspaceId);
  const neighbour = order[Math.min(removedIndex, order.length - 1)] ?? '';
  const activeWorkspaceId = state.activeWorkspaceId === workspaceId ? neighbour : state.activeWorkspaceId;

  return { workspaces, order, activeWorkspaceId };
}

/**
 * Closes a pane, removing its whole workspace when it was the last one — a view
 * with no terminals in it is not a view, it is a row that outlived its purpose.
 *
 * This is an ACTION rule, not an invariant over the state: a freshly created
 * workspace legitimately holds one pane with `scope: null` showing the picker,
 * so "a workspace with no bound panes gets removed" would delete every
 * workspace at birth. Only an explicit close removes anything.
 *
 * Returns the same state object when nothing changed, so callers can tell
 * whether to push (and {@link removedWorkspaceBy} whether to DELETE vs PATCH).
 */
export function closePaneIn(
  state: MachineWorkspacesState,
  workspaceId: string,
  paneId: string
): MachineWorkspacesState {
  if (!hasWorkspace(state, workspaceId)) return state;
  const workspace = state.workspaces[workspaceId];
  if (!findPaneLocation(workspace, paneId)) return state;

  if (panesOf(workspace).length <= 1) return removeWorkspace(state, workspaceId);
  return updateWorkspace(state, workspaceId, (current) => closePane(current, paneId));
}

/** Did {@link closePaneIn} take the whole workspace with it? The sync layer must
 * know: pushing a layout PATCH for a workspace that no longer exists 404s, and
 * that route's fallback RE-CREATES it server-side — resurrecting the exact row
 * the user just closed. */
export function removedWorkspaceBy(
  before: MachineWorkspacesState,
  after: MachineWorkspacesState,
  workspaceId: string
): boolean {
  return Boolean(before.workspaces[workspaceId]) && !after.workspaces[workspaceId];
}

// ---------------------------------------------------------------------------
// Server sync — reconciling the shared, pushed workspace list (#2048)
// ---------------------------------------------------------------------------

/**
 * The shared, server-owned half of a workspace — what `GET
 * /api/machines/workspaces` and every `machine-workspace:*` broadcast carry.
 * Deliberately mirrors (does not import) the server's `WorkspaceDTO`
 * (apps/web/src/lib/machines/machine-workspaces-runtime.ts): this reducer
 * cannot depend on an API route module, the same duplication already exists
 * between this file's `OpenTerminalScope`/`MachineNodeScope` and the
 * `machine_agent_terminals` schema's scope columns.
 *
 * Excludes `activePaneId`, `pendingPickerPaneId`, and any pane's
 * `pendingPrompt` — those are local-only UI state (see `sanitizeMachines`'s
 * doc) and are preserved from whatever this browser already had, never
 * overwritten by an incoming server payload.
 */
export interface ServerWorkspaceDTO {
  id: string;
  name: string;
  /** The union, as `toWorkspaceDTO` now emits it — but read through
   * {@link projectStoredNodeScope}, which re-derives the discriminant from the
   * names so an older server (or an in-flight `{projectName, branchName}`
   * payload) still lands correctly. */
  scope: MachineNodeScope | { projectName?: string; branchName?: string };
  columns: ServerColumnDTO[];
}

/** A pane AS IT ARRIVES. `{projectName, branchName}` are tolerated (and
 * dropped) rather than rejected: a client running the pre-narrowing code, or a
 * row it wrote before this shipped, still sends them. */
export interface ServerPaneDTO {
  id: string;
  scope: (PaneSessionScope & { projectName?: string; branchName?: string }) | null;
}

export interface ServerColumnDTO {
  id: string;
  panes: ServerPaneDTO[];
}

/** This browser's own panes for a workspace, addressed by id — the one lookup
 * {@link mergeColumns} needs to reconcile an incoming server payload against
 * what is already on screen. */
function panesById(existing: WorkspaceState | undefined): Map<string, TerminalPaneState> {
  const panes = new Map<string, TerminalPaneState>();
  if (!existing) return panes;
  for (const pane of panesOf(existing)) panes.set(pane.id, pane);
  return panes;
}

/**
 * Applies the server's columns, but keeps two things the incoming payload
 * cannot legitimately take away from a pane this browser already has:
 *
 * - its local-only `pendingPrompt` — a starting prompt not yet typed into its
 *   PTY must not be dropped just because an unrelated layout change from
 *   another browser landed (the server DTO has no such field at all);
 * - its `scope`, when the server's copy of that same pane is null.
 *
 * The second is a **monotone invariant, not a special case**: a pane's scope
 * only ever transitions null -> bound within that pane's lifetime. There is no
 * unbind flow — closing a session REMOVES the pane (`closePane`), it never
 * empties one — so a server pane whose scope is null landing on a same-id pane
 * this browser has already bound is ALWAYS a stale echo (this browser's own
 * pre-bind snapshot, or another instance's full-list GET, racing the bind
 * PATCH), never a newer truth. That race is the spawn double-row field bug:
 * losing the bind left one spawned agent showing as an empty workspace row PLUS
 * an unclaimed session row. Both merge paths — `applyServerUpsert` echoes and
 * the full-list hydrate — funnel through here, so both are covered.
 *
 * The rule is LOAD-BEARING ON "no unbind flow". If a pane ever gains a way to
 * be emptied in place, this stops being sound (a real unbind would be
 * indistinguishable from a stale echo) and must be replaced with rev-ordered
 * upserts: compare a monotonically increasing revision per workspace and drop
 * payloads older than what is applied. The schema has `updatedAt` but no rev,
 * and neither the DTO nor the broadcasts carry either — versioned upserts are
 * the eventual general mechanism, this is the invariant that makes them
 * unnecessary today.
 *
 * Panes the server DOESN'T list are still dropped: this guard defends an
 * existing pane's bind, it never resurrects a pane closed elsewhere.
 */
function mergeColumns(existing: WorkspaceState | undefined, serverColumns: ServerColumnDTO[]): TerminalColumnState[] {
  const localPanes = panesById(existing);
  return serverColumns.map((column) => ({
    id: column.id,
    panes: column.panes.map((pane) => {
      const local = localPanes.get(pane.id);
      // Projected on the way in (see `projectStoredPaneScope`): another
      // client's payload can still carry the wide, pre-narrowing pane scope.
      const scope = projectStoredPaneScope(pane.scope) ?? local?.scope ?? null;
      const pendingPrompt = local?.pendingPrompt;
      return pendingPrompt === undefined ? { id: pane.id, scope } : { id: pane.id, scope, pendingPrompt };
    }),
  }));
}

/** One server workspace, reconciled against whatever local copy (if any) this
 * browser already had — the shared fields come from the server; the local-only
 * ones (`activePaneId`, `pendingPickerPaneId`, panes' `pendingPrompt`) are
 * preserved when they still resolve, defaulted otherwise. */
function toLocalWorkspace(existing: WorkspaceState | undefined, ws: ServerWorkspaceDTO): WorkspaceState {
  const columns = mergeColumns(existing, ws.columns);
  const paneIds = columns.flatMap((column) => column.panes.map((pane) => pane.id));

  const activePaneId =
    existing && paneIds.includes(existing.activePaneId) ? existing.activePaneId : paneIds[0];
  const pendingPickerPaneId =
    existing?.pendingPickerPaneId && paneIds.includes(existing.pendingPickerPaneId) ? existing.pendingPickerPaneId : null;

  return {
    id: ws.id,
    name: ws.name,
    scope: projectStoredNodeScope(ws.scope) ?? MACHINE_NODE_SCOPE,
    columns,
    activePaneId,
    pendingPickerPaneId,
  };
}

/**
 * Reconciles a machine's FULL server workspace list into its local state —
 * used once, on initial load (`useMachineWorkspaceSync`'s hydrate step).
 * `order` follows the server's list order (`createdAt` ascending).
 *
 * Deliberately does NOT keep local-only stragglers — a workspace this browser
 * has locally but the server list doesn't include. `ensureMachine` runs
 * synchronously, before the server ever answers, so by the time this merge
 * sees it, one of two things is true: either this browser's local list was
 * exactly what got bootstrapped (same ids come back, no stragglers to begin
 * with), or it LOST the bootstrap race / the machine was already bootstrapped
 * by someone else — in which case its own local-only workspace is a disposable
 * placeholder or unmigrated pre-existing history, not data the server has
 * ever agreed exists. Keeping it would leave a phantom workspace in the
 * sidebar forever, since nothing re-reconciles or prunes it after this one
 * hydrate. This is the accepted limitation of first-writer-bootstrap (see
 * machine-workspaces.ts's module doc): the loser's unpublished history is not
 * merged in.
 */
export function mergeServerWorkspaces(
  local: MachineWorkspacesState | undefined,
  serverWorkspaces: ServerWorkspaceDTO[]
): MachineWorkspacesState {
  const workspaces: Record<string, WorkspaceState> = {};
  const order: string[] = [];

  for (const ws of serverWorkspaces) {
    // Skip rather than assign: `workspaces[ws.id] = ...` is a plain [[Set]]
    // on an already-created object, so a `ws.id` of exactly `"__proto__"`
    // would invoke the inherited setter and reassign THIS object's own
    // prototype (unlike the spread-with-computed-key writes elsewhere in
    // this file, which object-literal syntax exempts from that special
    // case) — a real, not merely theoretical, corruption vector here.
    if (isUnsafeRecordKey(ws.id)) continue;
    workspaces[ws.id] = toLocalWorkspace(local && hasWorkspace(local, ws.id) ? local.workspaces[ws.id] : undefined, ws);
    order.push(ws.id);
  }

  // An empty server list is a real, converged answer — the user removed every
  // view — so it is applied, not treated as an impossible reading to fall back
  // from. Keeping `local` here (the old behaviour) meant "server has zero"
  // could NEVER converge: this hydrate runs once per mount and nothing prunes
  // afterwards, so the phantom rows outlived every reload.
  const activeWorkspaceId =
    local && workspaces[local.activeWorkspaceId] ? local.activeWorkspaceId : (order[0] ?? '');
  return { workspaces, order, activeWorkspaceId };
}

/** Reconciles ONE incoming `machine-workspace:created`/`:updated` event —
 * same per-workspace merge as {@link mergeServerWorkspaces}, appending to
 * `order` if this browser didn't already know about it. */
export function applyServerWorkspaceUpsert(state: MachineWorkspacesState, ws: ServerWorkspaceDTO): MachineWorkspacesState {
  if (isUnsafeRecordKey(ws.id)) return state;
  const existing = hasWorkspace(state, ws.id) ? state.workspaces[ws.id] : undefined;
  const workspaces = { ...state.workspaces, [ws.id]: toLocalWorkspace(existing, ws) };
  const order = existing ? state.order : [...state.order, ws.id];
  return { ...state, workspaces, order };
}

/** Reconciles an incoming `machine-workspace:deleted` event — delegates to
 * {@link removeWorkspace}, which now applies to the last workspace too. Under
 * the old floor this event was silently DROPPED for the final row, so a browser
 * whose teammate removed the last view kept a phantom of it forever (nothing
 * re-reconciles after the once-per-mount hydrate). */
export function applyServerWorkspaceDeleted(state: MachineWorkspacesState, workspaceId: string): MachineWorkspacesState {
  return removeWorkspace(state, workspaceId);
}

// ---------------------------------------------------------------------------
// Rehydration — what comes back out of localStorage is untrusted
// ---------------------------------------------------------------------------

function isPane(value: unknown): value is TerminalPaneState {
  if (typeof value !== 'object' || value === null) return false;
  const pane = value as Partial<TerminalPaneState>;
  return typeof pane.id === 'string' && (pane.scope === null || typeof pane.scope === 'object');
}

/**
 * Migrates a workspace id persisted by a version of this app that predates
 * the U+001F delimiter switch (see `sessionWorkspaceId`'s doc): those ids used
 * U+0000 (NUL) instead, which the server's `machine_workspaces.id` column
 * (Postgres `text`) rejects outright. Without this, a returning user's
 * session-derived workspaces would fail every bootstrap attempt forever —
 * `useMachineWorkspaceSync` posts whatever this browser holds locally
 * verbatim, and the same doomed id would keep coming back on every retry.
 *
 * A plain 1:1 character substitution preserves the "same session, same id"
 * property (two different sessions that produced different pre-migration ids
 * still produce different post-migration ids), and is a no-op for every other
 * id shape (`crypto.randomUUID()` never contains either character).
 */
function migrateLegacyWorkspaceId(id: string): string {
  return id.includes('\u0000') ? id.replaceAll('\u0000', '\u001f') : id;
}

function isWorkspace(value: unknown): value is WorkspaceState {
  if (typeof value !== 'object' || value === null) return false;
  const workspace = value as Partial<WorkspaceState>;
  return (
    typeof workspace.id === 'string' &&
    typeof workspace.name === 'string' &&
    // Only "an object" — the shape is PROJECTED below, not validated: a blob
    // written before the discriminant existed carries bare names, and dropping
    // those workspaces would cost a returning user every pane layout they have.
    typeof workspace.scope === 'object' &&
    workspace.scope !== null &&
    Array.isArray(workspace.columns) &&
    workspace.columns.length > 0 &&
    workspace.columns.every(
      (column) =>
        typeof column?.id === 'string' &&
        Array.isArray(column.panes) &&
        column.panes.length > 0 &&
        column.panes.every(isPane)
    ) &&
    typeof workspace.activePaneId === 'string'
  );
}

/**
 * Scrubs a rehydrated `machines` blob down to what this code can actually
 * render, dropping anything it can't.
 *
 * Persisted state is written by whatever version of this app the user last ran.
 * A shape that no longer matches (a renamed field, a restructured column) would
 * otherwise flow straight into render — `columns.flatMap` on an undefined
 * `columns` throws, and a throw here takes the whole Machine page down for a
 * returning user, permanently, with no in-app way to clear the storage. Dropping
 * a stale workspace costs the user a pane layout; keeping it costs them the page.
 *
 * Transient UI intent is stripped on the way in as well: `pendingPickerPaneId`
 * (a picker that auto-focused days ago must not steal the caret on load) and
 * `pendingPrompt` (see `assignPane` — a prompt that was never delivered must
 * never be typed at an agent that has been running ever since).
 *
 * Every workspace/order/activeWorkspaceId id also passes through
 * `migrateLegacyWorkspaceId` (#2048) — a returning user may have session-
 * derived ids minted before the NUL-to-U+001F delimiter switch, and those
 * would otherwise fail every server-sync bootstrap attempt forever.
 */
export function sanitizeMachines(value: unknown): Record<string, MachineWorkspacesState> {
  if (typeof value !== 'object' || value === null) return {};

  const machines: Record<string, MachineWorkspacesState> = {};

  for (const [machineId, machine] of Object.entries(value as Record<string, unknown>)) {
    // Same untrusted-JSON concern as the `workspaces[migratedId] = …` guard
    // below: `machines[machineId] = …` is a plain assignment, so a machine
    // id of exactly "__proto__" would reassign THIS object's own prototype.
    if (isUnsafeRecordKey(machineId)) continue;
    if (typeof machine !== 'object' || machine === null) continue;
    const candidate = machine as Partial<MachineWorkspacesState>;
    if (typeof candidate.workspaces !== 'object' || candidate.workspaces === null) continue;

    const workspaces: Record<string, WorkspaceState> = {};
    for (const [workspaceId, workspace] of Object.entries(candidate.workspaces)) {
      if (!isWorkspace(workspace)) continue;
      // Untrusted JSON (this whole function's reason to exist): a persisted
      // key of exactly "__proto__" would, via the plain `workspaces[id] = …`
      // assignment below, invoke the inherited setter and reassign THIS
      // object's own prototype rather than merely add an entry.
      if (isUnsafeRecordKey(migrateLegacyWorkspaceId(workspaceId))) continue;

      const columns = workspace.columns.map((column) => ({
        ...column,
        // Same read-time projection as `mergeColumns`: a blob written before
        // the pane scope narrowed still carries the checkout per pane.
        panes: column.panes.map((pane) => ({ id: pane.id, scope: projectStoredPaneScope(pane.scope) })),
      }));
      const paneIds = columns.flatMap((column) => column.panes.map((pane) => pane.id));

      // Migrate a legacy NUL-delimited id (see `migrateLegacyWorkspaceId`'s
      // doc) — the record key and the object's own `id` field must agree,
      // since `order`/`activeWorkspaceId` below reference the record key.
      const migratedId = migrateLegacyWorkspaceId(workspaceId);
      workspaces[migratedId] = {
        ...workspace,
        id: migratedId,
        scope: projectStoredNodeScope(workspace.scope) ?? MACHINE_NODE_SCOPE,
        columns,
        // An activePaneId naming no pane is not merely cosmetic: every grid
        // transition no-ops on a pane it cannot resolve, so a split anchored on
        // it would silently do nothing.
        activePaneId: paneIds.includes(workspace.activePaneId) ? workspace.activePaneId : paneIds[0],
        pendingPickerPaneId: null,
      };
    }

    // `hasOwn`, not a bare truthy bracket read: `workspaces['constructor']`/
    // `workspaces['__proto__']` resolve through the prototype chain to a
    // real (truthy) inherited value even though no such workspace exists,
    // which would otherwise let a persisted phantom id survive into `order`.
    const order = (Array.isArray(candidate.order) ? candidate.order : [])
      .map((id) => (typeof id === 'string' ? migrateLegacyWorkspaceId(id) : id))
      .filter((id) => typeof id === 'string' && Object.hasOwn(workspaces, id));
    if (order.length === 0) continue;

    const migratedActiveWorkspaceId =
      typeof candidate.activeWorkspaceId === 'string' ? migrateLegacyWorkspaceId(candidate.activeWorkspaceId) : undefined;
    const activeWorkspaceId =
      migratedActiveWorkspaceId && Object.hasOwn(workspaces, migratedActiveWorkspaceId) ? migratedActiveWorkspaceId : order[0];

    machines[machineId] = { workspaces, order, activeWorkspaceId };
  }

  return machines;
}

/**
 * The id of the workspace owned by one session — derived from the session
 * rather than random, so clicking that sidebar row again lands on the SAME
 * workspace, with whatever panes were split into it still there. Joined with
 * U+001F (Unit Separator): project and branch names can contain '/' and ':',
 * so an ordinary character can't be used as the delimiter. NOT NUL (U+0000)
 * — this id is also the primary key of the server-side `machine_workspaces`
 * row (see `machine-workspaces-runtime.ts`), and Postgres `text` columns
 * reject a literal NUL byte outright.
 */
export function sessionWorkspaceId(scope: OpenTerminalScope): string {
  return `session\u001f${scope.projectName ?? ''}\u001f${scope.branchName ?? ''}\u001f${scope.name}`;
}

/** Auto-name for a workspace the user created empty ("Workspace 1", "Workspace
 * 2", …) — first free index, so closing #2 and adding again reuses the gap
 * instead of drifting upward forever. */
export function nextWorkspaceName(state: MachineWorkspacesState): string {
  const taken = new Set(workspacesOf(state).map((workspace) => workspace.name));
  for (let index = 1; ; index++) {
    const name = `Workspace ${index}`;
    if (!taken.has(name)) return name;
  }
}

const AUTO_NAME_SUFFIX_LENGTH = 6;

/**
 * The auto-name for a split-and-pick spawn. Picking an agent is ONE act — no
 * name step — but `agent_terminals` rows are still keyed by name within a
 * scope, so one is minted here: the agent type (what the user actually chose,
 * so the name still means something) plus a short unique suffix, since a
 * workspace routinely runs several agents of the same type.
 *
 * `suffix` is passed in rather than generated, keeping this pure. The output
 * always satisfies `isValidAgentTerminalName` (`/^[A-Za-z0-9][A-Za-z0-9_-]*$/`)
 * for every agent type in AGENT_LAUNCH_SPECS.
 */
export function autoSessionName(agentType: string, suffix: string): string {
  const cleanSuffix = suffix.replace(/[^A-Za-z0-9]/g, '').slice(0, AUTO_NAME_SUFFIX_LENGTH);
  return cleanSuffix ? `${agentType}-${cleanSuffix}` : agentType;
}
